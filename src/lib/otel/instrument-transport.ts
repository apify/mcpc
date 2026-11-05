/**
 * OpenTelemetry instrumentation for an MCP client transport.
 *
 * Wraps an SDK `Transport` so that every outbound JSON-RPC request and notification gets
 * a CLIENT span and a `mcp.client.operation.duration` measurement, following the
 * OpenTelemetry semantic conventions for MCP, and carries the active trace context in
 * `params._meta` (`traceparent`, `tracestate`, `baggage` — SEP-414), so the server's own
 * spans join the same trace.
 *
 * The MCP TypeScript SDK gained equivalent built-in instrumentation on `main`
 * (modelcontextprotocol/typescript-sdk#3115: instrumentation scope
 * `@modelcontextprotocol/client`, the same span names, attributes, metric and `_meta`
 * propagation). It has not been released yet, so this module is mcpc's stand-in. Once mcpc
 * updates to an SDK that ships it: delete this module, stop wrapping the transport in the
 * bridge (the SDK instruments every `Client` by default) and keep the rest of the `--otel`
 * runtime, which only registers the SDK the instrumentation reports to.
 *
 * Nothing here records tool arguments, tool results or prompt arguments. Resource URIs are
 * recorded on spans, as the conventions allow, but never on metrics.
 */

import type {
  JSONRPCMessage,
  JSONRPCNotification,
  JSONRPCRequest,
  RequestId,
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/client';
import {
  PROTOCOL_VERSION_META_KEY,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
} from '@modelcontextprotocol/client';
import {
  SpanKind,
  SpanStatusCode,
  context,
  defaultTextMapSetter,
  diag,
  metrics,
  propagation,
  trace,
  type Attributes,
  type Histogram,
  type Span,
} from './otel.js';

/** Instrumentation scope reported on every span and metric mcpc emits. */
export const INSTRUMENTATION_SCOPE = '@apify/mcpc';

/** Histogram of request/notification durations as seen by the sender (seconds). */
export const DURATION_METRIC_NAME = 'mcp.client.operation.duration';

/** Bucket boundaries the MCP semantic conventions recommend for the duration histogram. */
const DURATION_BUCKET_BOUNDARIES_SECS = [
  0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300,
];

// Attribute names from the OpenTelemetry semantic conventions (MCP, GenAI, RPC, network).
const ATTR_MCP_METHOD_NAME = 'mcp.method.name';
const ATTR_MCP_PROTOCOL_VERSION = 'mcp.protocol.version';
const ATTR_MCP_SESSION_ID = 'mcp.session.id';
const ATTR_MCP_RESOURCE_URI = 'mcp.resource.uri';
const ATTR_JSONRPC_REQUEST_ID = 'jsonrpc.request.id';
const ATTR_GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
const ATTR_GEN_AI_TOOL_NAME = 'gen_ai.tool.name';
const ATTR_GEN_AI_PROMPT_NAME = 'gen_ai.prompt.name';
const ATTR_RPC_RESPONSE_STATUS_CODE = 'rpc.response.status_code';
const ATTR_ERROR_TYPE = 'error.type';
const ATTR_SERVER_ADDRESS = 'server.address';
const ATTR_SERVER_PORT = 'server.port';
const ATTR_NETWORK_TRANSPORT = 'network.transport';
const ATTR_NETWORK_PROTOCOL_NAME = 'network.protocol.name';

/**
 * Methods recorded by name on the metric. Anything else becomes `_OTHER`, so the metric's
 * cardinality stays bounded whatever a future extension sends (spans keep the real name).
 */
const KNOWN_METHODS = new Set([
  'initialize',
  'ping',
  'server/discover',
  'sessions/create',
  'sessions/delete',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'resources/subscribe',
  'resources/unsubscribe',
  'resources/directory/read',
  'prompts/list',
  'prompts/get',
  'completion/complete',
  'logging/setLevel',
  'subscriptions/listen',
  'tasks/get',
  'tasks/result',
  'tasks/list',
  'tasks/cancel',
  'skills/list',
  'skills/get',
  'notifications/initialized',
  'notifications/cancelled',
  'notifications/progress',
  'notifications/roots/list_changed',
]);

/** Methods whose `uri` parameter is recorded as `mcp.resource.uri` (spans only). */
const RESOURCE_URI_METHODS = new Set([
  'resources/read',
  'resources/subscribe',
  'resources/unsubscribe',
  'resources/directory/read',
]);

/** Per-method target that names the span and is recorded as a GenAI attribute. */
const TARGET_ATTRIBUTES: Record<string, string> = {
  'tools/call': ATTR_GEN_AI_TOOL_NAME,
  'prompts/get': ATTR_GEN_AI_PROMPT_NAME,
};

export interface InstrumentTransportOptions {
  /**
   * URL of a Streamable HTTP server; omit for stdio. Sets `server.address`, `server.port`
   * and the `network.*` attributes.
   */
  serverUrl?: string;
  /** Version reported with the instrumentation scope (mcpc's own version). */
  scopeVersion?: string;
}

/** How an operation ended; `errorType` absent means success. */
interface Outcome {
  errorType?: string;
  /** JSON-RPC error code, recorded as `rpc.response.status_code`. */
  rpcErrorCode?: number;
  message?: string;
  exception?: unknown;
}

/** An in-flight request or notification. */
interface Operation {
  method: string;
  span: Span;
  startedAtMillis: number;
  metricAttributes: Attributes;
  /** Detaches the per-request abort listener, when one was armed. */
  cleanup?: () => void;
}

type Params = Record<string, unknown> | undefined;

/**
 * Wrap a transport so every message it sends is traced and measured, and carries the
 * active trace context in `_meta`. The returned object forwards everything else to the
 * wrapped transport (it is a Proxy, so transport-specific members such as the Streamable
 * HTTP `terminateSession()` stay reachable).
 */
export function instrumentTransport(
  inner: Transport,
  options: InstrumentTransportOptions = {}
): Transport {
  return new TransportInstrumentation(inner, options).proxy;
}

class TransportInstrumentation {
  readonly proxy: Transport;
  private readonly connectionAttributes: Attributes;
  private readonly scopeVersion: string | undefined;
  private readonly pending = new Map<string, Operation>();
  private protocolVersion: string | undefined;
  /** Cached with the meter provider it came from — re-created if the global provider changes. */
  private histogram: { provider: unknown; instrument: Histogram } | undefined;
  private onmessage: Transport['onmessage'];
  private onclose: Transport['onclose'];
  private onerror: Transport['onerror'];

  constructor(
    private readonly inner: Transport,
    options: InstrumentTransportOptions
  ) {
    this.connectionAttributes = connectionAttributes(options.serverUrl);
    this.scopeVersion = options.scopeVersion;

    // Observe inbound traffic and the close event once, on the wrapped transport; the
    // handlers the SDK client installs later are stored here and called through.
    // Instrumentation failures are reported through the SDK's diag channel and never
    // interfere with message delivery.
    inner.onmessage = (message, extra) => {
      guarded(() => this.observeInbound(message));
      this.onmessage?.(message, extra);
    };
    inner.onclose = () => {
      guarded(() => this.finishAll({ errorType: 'connection_closed' }));
      this.onclose?.();
    };
    inner.onerror = (error) => this.onerror?.(error);

    this.proxy = new Proxy(inner, {
      get: (target, property) => {
        switch (property) {
          case 'send':
            return this.send;
          case 'setProtocolVersion':
            return this.setProtocolVersion;
          case 'onmessage':
            return this.onmessage;
          case 'onclose':
            return this.onclose;
          case 'onerror':
            return this.onerror;
          default: {
            // Bind methods to the real transport: its own `this` (private fields included)
            // must never be the proxy.
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? (value as () => void).bind(target) : value;
          }
        }
      },
      set: (target, property, value) => {
        switch (property) {
          case 'onmessage':
            this.onmessage = value as Transport['onmessage'];
            return true;
          case 'onclose':
            this.onclose = value as Transport['onclose'];
            return true;
          case 'onerror':
            this.onerror = value as Transport['onerror'];
            return true;
          default:
            return Reflect.set(target, property, value, target);
        }
      },
    });
  }

  /** The SDK client reports the negotiated version here (legacy handshake) — record it. */
  private readonly setProtocolVersion = (version: string): void => {
    this.protocolVersion = version;
    this.inner.setProtocolVersion?.(version);
  };

  private readonly send = async (
    message: JSONRPCMessage,
    options?: TransportSendOptions
  ): Promise<void> => {
    if (isJSONRPCRequest(message)) return this.sendRequest(message, options);
    if (isJSONRPCNotification(message)) return this.sendNotification(message, options);
    // Responses to server-initiated requests are not client operations.
    return this.inner.send(message, options);
  };

  private async sendRequest(
    message: JSONRPCRequest,
    options?: TransportSendOptions
  ): Promise<void> {
    const started = guarded(() => this.startOperation(message.method, message.params, message.id));
    if (!started) return this.inner.send(message, options);
    const { operation, params } = started;
    const key = String(message.id);
    this.pending.set(key, operation);

    // On 2026-07-28 Streamable HTTP connections the SDK cancels a request (timeout or
    // caller abort) by aborting its per-request stream instead of sending
    // `notifications/cancelled` — the only signal that the span will never see a response.
    const requestSignal = options?.requestSignal;
    if (requestSignal) {
      const onAbort = (): void => guarded(() => this.finish(key, { errorType: 'cancelled' }));
      requestSignal.addEventListener('abort', onAbort, { once: true });
      operation.cleanup = () => requestSignal.removeEventListener('abort', onAbort);
    }

    try {
      await this.inner.send({ ...message, params }, options);
    } catch (error) {
      guarded(() =>
        this.finish(key, {
          errorType: errorCode(error),
          message: errorMessage(error),
          exception: error,
        })
      );
      throw error;
    }
  }

  private async sendNotification(
    message: JSONRPCNotification,
    options?: TransportSendOptions
  ): Promise<void> {
    const started = guarded(() => this.startOperation(message.method, message.params));
    if (!started) return this.inner.send(message, options);
    const { operation, params } = started;

    // The SDK withdraws a timed-out or aborted request with this notification (legacy
    // handshake connections, and stdio on every version).
    if (message.method === 'notifications/cancelled') {
      const requestId = message.params?.requestId;
      if (requestId !== undefined) {
        const reason = String(message.params?.reason ?? '');
        guarded(() =>
          this.finish(String(requestId as RequestId), {
            errorType: /timed out/i.test(reason) ? 'timeout' : 'cancelled',
            ...(reason && { message: reason }),
          })
        );
      }
    }

    try {
      await this.inner.send({ ...message, params }, options);
      guarded(() => this.end(operation, {}));
    } catch (error) {
      guarded(() =>
        this.end(operation, {
          errorType: errorCode(error),
          message: errorMessage(error),
          exception: error,
        })
      );
      throw error;
    }
  }

  /**
   * Start the span for an outbound message and inject the resulting trace context into
   * a copy of its params. Without a registered SDK the span context is invalid, nothing
   * is injected and the params are returned untouched.
   */
  private startOperation(
    method: string,
    params: Params,
    requestId?: RequestId
  ): { operation: Operation; params: Params } {
    const attributes: Attributes = {
      [ATTR_MCP_METHOD_NAME]: method,
      ...this.connectionAttributes,
    };
    const version = this.protocolVersion ?? stringAt(params?._meta, PROTOCOL_VERSION_META_KEY);
    if (version) attributes[ATTR_MCP_PROTOCOL_VERSION] = version;
    if (method === 'tools/call') attributes[ATTR_GEN_AI_OPERATION_NAME] = 'execute_tool';
    const targetAttribute = TARGET_ATTRIBUTES[method];
    const target = targetAttribute ? stringAt(params, 'name') : undefined;
    if (targetAttribute && target) attributes[targetAttribute] = target;

    // Metrics never carry session ids, request ids or resource URIs, and bound the method
    // name to the known set.
    const metricAttributes: Attributes = {
      ...attributes,
      [ATTR_MCP_METHOD_NAME]: KNOWN_METHODS.has(method) ? method : '_OTHER',
    };

    const spanAttributes: Attributes = { ...attributes };
    if (requestId !== undefined) spanAttributes[ATTR_JSONRPC_REQUEST_ID] = String(requestId);
    const sessionId = this.inner.sessionId;
    if (sessionId) spanAttributes[ATTR_MCP_SESSION_ID] = sessionId;
    const uri = RESOURCE_URI_METHODS.has(method) ? stringAt(params, 'uri') : undefined;
    if (uri) spanAttributes[ATTR_MCP_RESOURCE_URI] = uri;

    const span = trace
      .getTracer(INSTRUMENTATION_SCOPE, this.scopeVersion)
      .startSpan(target ? `${method} ${target}` : method, {
        kind: SpanKind.CLIENT,
        attributes: spanAttributes,
      });

    const carrier: Record<string, string> = {};
    propagation.inject(trace.setSpan(context.active(), span), carrier, defaultTextMapSetter);
    const outbound: Params =
      Object.keys(carrier).length > 0
        ? { ...params, _meta: { ...asRecord(params?._meta), ...carrier } }
        : params;

    return {
      operation: { method, span, startedAtMillis: performance.now(), metricAttributes },
      params: outbound,
    };
  }

  private observeInbound(message: JSONRPCMessage): void {
    if (isJSONRPCErrorResponse(message)) {
      this.finish(String(message.id), {
        errorType: String(message.error.code),
        rpcErrorCode: message.error.code,
        message: message.error.message,
      });
    } else if (isJSONRPCResultResponse(message)) {
      const key = String(message.id);
      const operation = this.pending.get(key);
      if (!operation) return;
      const toolFailed =
        operation.method === 'tools/call' && asRecord(message.result).isError === true;
      this.finish(key, toolFailed ? { errorType: 'tool_error' } : {});
    }
  }

  private finish(key: string, outcome: Outcome): void {
    const operation = this.pending.get(key);
    if (!operation) return;
    this.pending.delete(key);
    operation.cleanup?.();
    this.end(operation, outcome);
  }

  private finishAll(outcome: Outcome): void {
    for (const key of Array.from(this.pending.keys())) this.finish(key, outcome);
  }

  private end(operation: Operation, outcome: Outcome): void {
    const { span, metricAttributes } = operation;
    if (outcome.errorType !== undefined) {
      span.setAttribute(ATTR_ERROR_TYPE, outcome.errorType);
      metricAttributes[ATTR_ERROR_TYPE] = outcome.errorType;
      if (outcome.rpcErrorCode !== undefined) {
        span.setAttribute(ATTR_RPC_RESPONSE_STATUS_CODE, String(outcome.rpcErrorCode));
      }
      if (outcome.exception instanceof Error) span.recordException(outcome.exception);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        ...(outcome.message && { message: outcome.message }),
      });
    }
    span.end();
    this.getHistogram().record(
      (performance.now() - operation.startedAtMillis) / 1000,
      metricAttributes
    );
  }

  private getHistogram(): Histogram {
    const provider = metrics.getMeterProvider();
    if (!this.histogram || this.histogram.provider !== provider) {
      const instrument = provider
        .getMeter(INSTRUMENTATION_SCOPE, this.scopeVersion)
        .createHistogram(DURATION_METRIC_NAME, {
          description: 'Duration of MCP client operations, as observed by the sender',
          unit: 's',
          advice: { explicitBucketBoundaries: DURATION_BUCKET_BOUNDARIES_SECS },
        });
      this.histogram = { provider, instrument };
    }
    return this.histogram.instrument;
  }
}

/** `server.*` / `network.*` attributes shared by every operation on the connection. */
function connectionAttributes(serverUrl: string | undefined): Attributes {
  if (!serverUrl) return { [ATTR_NETWORK_TRANSPORT]: 'pipe' };
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return { [ATTR_NETWORK_TRANSPORT]: 'tcp' };
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return {
    [ATTR_SERVER_ADDRESS]: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    [ATTR_SERVER_PORT]: port,
    [ATTR_NETWORK_TRANSPORT]: 'tcp',
    [ATTR_NETWORK_PROTOCOL_NAME]: 'http',
  };
}

/**
 * Run an instrumentation step; a failure is reported on the OpenTelemetry diag channel
 * (the bridge log) and otherwise ignored, so telemetry can never take a request down.
 */
function guarded<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    diag.error('mcpc: OpenTelemetry instrumentation failed', error);
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function stringAt(value: unknown, key: string): string | undefined {
  const found = asRecord(value)[key];
  return typeof found === 'string' && found !== '' ? found : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `error.type` for a send that threw: the SDK's error code when it has one, else `SEND_FAILED`. */
function errorCode(error: unknown): string {
  const code = asRecord(error).code;
  return typeof code === 'string' && code !== '' ? code : 'SEND_FAILED';
}
