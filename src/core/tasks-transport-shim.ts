/**
 * Adapter that lets the official SDK v2 (`@modelcontextprotocol/client` 2.0.0) carry the
 * tasks extension (`io.modelcontextprotocol/tasks`, MCP 2026-07-28) before it implements
 * the extension itself.
 *
 * The SDK keeps the 2025-11-25 task vocabulary as legacy-only and knows nothing of the
 * 2026-07-28 extension, which gets in the way in three places:
 *
 * 1. **Outbound era gate.** `tasks/get` and `tasks/cancel` are names from the 2025 core
 *    protocol, so the client refuses to send them on a 2026-07-28 connection ("not
 *    supported by the negotiated protocol version") — although the extension reuses those
 *    very names. mcpc therefore issues them under a local alias the gate does not know
 *    ({@link aliasTaskMethod}), and this shim restores the real method name on the way
 *    to the transport. The alias never reaches the wire; the HTTP transport derives its
 *    `Mcp-Method` header from the restored message.
 * 2. **Inbound result decoding.** The 2026-era decoder rejects any `resultType` other
 *    than `complete` and `input_required` before a caller's result schema runs, so a
 *    `CreateTaskResult` (`resultType: "task"`) answering `tools/call` would surface as an
 *    "unsupported result type" error with the task ID lost. The shim rewrites such a
 *    response into a placeholder `CallToolResult` the decoder accepts and hands the task
 *    over in `_meta` ({@link CREATED_TASK_META_KEY}). {@link TasksTransportShim.takeCreatedTask}
 *    recognizes the placeholder by object identity, so a server cannot forge one by
 *    sending that `_meta` key itself.
 * 3. **Routing header.** The spec requires `Mcp-Name: <taskId>` on `tasks/get`,
 *    `tasks/update` and `tasks/cancel` over Streamable HTTP, so intermediaries can route
 *    a task's requests to the instance holding its state. The transport derives
 *    `Mcp-Name` from `params.name` only and treats the header as reserved, so
 *    {@link withTaskRoutingHeader} adds it at the `fetch` layer instead.
 *
 * Everything else — the per-request `_meta` envelope, client capability declaration,
 * auth, reconnection — stays the SDK's. Remove this module once the SDK ships the
 * extension; `McpClient` is its only consumer.
 */

import type {
  FetchLike,
  JSONRPCMessage,
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/client';

/**
 * Prefix of the local alias under which era-gated task methods travel through the SDK
 * client. Deliberately no spec method starts with it.
 */
const TASK_METHOD_ALIAS_PREFIX = 'mcpc-tasks-extension:';

/** The extension's request methods. */
export type TaskMethod = 'tasks/get' | 'tasks/cancel' | 'tasks/update';

/** Methods whose requests the spec requires to carry `Mcp-Name: <taskId>` over HTTP. */
export const TASK_ROUTED_METHODS: readonly TaskMethod[] = [
  'tasks/get',
  'tasks/update',
  'tasks/cancel',
];

/**
 * `_meta` key under which the placeholder result carries the task a server created in
 * lieu of a tool result. Never printed: `McpClient` unwraps it before anything else sees
 * the result.
 */
export const CREATED_TASK_META_KEY = 'com.apify.mcpc/created-task';

/** The alias `client.request()` accepts for an extension method the era gate would refuse. */
export function aliasTaskMethod(method: TaskMethod): string {
  return `${TASK_METHOD_ALIAS_PREFIX}${method}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Restore the real method name of an aliased outbound request (see {@link aliasTaskMethod}). */
function unaliasMethod(message: JSONRPCMessage): JSONRPCMessage {
  if (Array.isArray(message) || !isRecord(message)) return message;
  const { method } = message as { method?: unknown };
  if (typeof method !== 'string' || !method.startsWith(TASK_METHOD_ALIAS_PREFIX)) return message;
  return { ...message, method: method.slice(TASK_METHOD_ALIAS_PREFIX.length) } as JSONRPCMessage;
}

/**
 * Wraps one connection's transport so the SDK client can speak the tasks extension over
 * it. One instance per `McpClient`; `takeCreatedTask` only recognizes placeholders this
 * instance produced.
 */
export class TasksTransportShim {
  /** Task objects this shim lifted out of `CreateTaskResult` responses, by identity. */
  private readonly created = new WeakSet<object>();

  /**
   * Wrap a transport. The proxy forwards everything to the underlying transport (methods
   * bound to it, so its private state stays reachable) and intercepts just two things:
   * outbound `send`, to restore aliased method names, and the `onmessage` handler the SDK
   * installs, to rewrite `CreateTaskResult` responses before the SDK decodes them.
   */
  wrap(transport: Transport): Transport {
    const rewriteInbound = (message: JSONRPCMessage): JSONRPCMessage =>
      this.rewriteCreatedTaskResult(message);
    return new Proxy(transport, {
      get(target, property) {
        if (property === 'send') {
          return (message: JSONRPCMessage, options?: TransportSendOptions) =>
            target.send(unaliasMethod(message), options);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
      set(target, property, value) {
        if (property === 'onmessage' && typeof value === 'function') {
          const handler = value as NonNullable<Transport['onmessage']>;
          target.onmessage = (message, extra) => handler(rewriteInbound(message), extra);
          return true;
        }
        return Reflect.set(target, property, value, target);
      },
    });
  }

  /**
   * The task a server created in lieu of the tool result, when `result` is a placeholder
   * this shim produced; `undefined` for any genuine tool result — including one whose
   * `_meta` merely spells the same key, since only the object lifted here has the
   * identity `created` remembers.
   */
  takeCreatedTask(result: unknown): Record<string, unknown> | undefined {
    if (!isRecord(result) || !isRecord(result._meta)) return undefined;
    const task = result._meta[CREATED_TASK_META_KEY];
    return isRecord(task) && this.created.has(task) ? task : undefined;
  }

  /**
   * Turn a `CreateTaskResult` response into a placeholder the SDK's 2026-era decoder
   * accepts for `tools/call`, carrying the task in `_meta`. Every other message passes
   * through untouched; in particular the 2025-11-25 `CreateTaskResult` (`{ task }`, no
   * `resultType`) is decoded by the SDK as before.
   */
  private rewriteCreatedTaskResult(message: JSONRPCMessage): JSONRPCMessage {
    if (Array.isArray(message) || !isRecord(message) || !('id' in message)) return message;
    const result = (message as { result?: unknown }).result;
    if (!isRecord(result) || result.resultType !== 'task') return message;

    const { resultType: _resultType, _meta, ...task } = result;
    this.created.add(task);
    const placeholder = {
      resultType: 'complete',
      content: [],
      // The SDK validates a tool result's `structuredContent` against the tool's
      // `outputSchema` unless the result is an error. This placeholder carries no tool
      // output at all — the task does — so the flag keeps that check off it. McpClient
      // discards the placeholder as soon as it has taken the task out of it.
      isError: true,
      _meta: { ...(isRecord(_meta) ? _meta : {}), [CREATED_TASK_META_KEY]: task },
    };
    return { ...message, result: placeholder } as JSONRPCMessage;
  }
}

/**
 * `true` when `value` cannot travel as a plain ASCII HTTP field value (RFC 9110 §5.5):
 * empty, surrounding whitespace, a byte outside `0x20–0x7E`/`0x09`, or something that
 * already looks like the Base64 sentinel. Mirrors the SDK's own rule for `Mcp-Name`.
 */
function needsBase64(value: string): boolean {
  if (value.length === 0 || value !== value.trim()) return true;
  if (value.startsWith('=?base64?') && value.endsWith('?=')) return true;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code !== 9 && (code < 32 || code > 126)) return true;
  }
  return false;
}

/** Encode a header value per the MCP value-encoding rules (`=?base64?…?=` when needed). */
export function encodeHeaderValue(value: string): string {
  return needsBase64(value) ? `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=` : value;
}

/** The `params.taskId` of a routed task request in a POST body, or `undefined`. */
function routedTaskIdOf(init: RequestInit | undefined): string | undefined {
  if (init?.method !== 'POST' || typeof init.body !== 'string') return undefined;
  // Cheap pre-check before parsing: every routed method name contains this.
  if (!init.body.includes('"tasks/')) return undefined;
  let message: unknown;
  try {
    message = JSON.parse(init.body);
  } catch {
    return undefined;
  }
  if (!isRecord(message) || !isRecord(message.params)) return undefined;
  if (!(TASK_ROUTED_METHODS as readonly unknown[]).includes(message.method)) return undefined;
  const { taskId } = message.params;
  return typeof taskId === 'string' && taskId.length > 0 ? taskId : undefined;
}

/**
 * Wrap a `fetch` so `tasks/get`, `tasks/update` and `tasks/cancel` requests carry the
 * `Mcp-Name: <taskId>` routing header the spec requires. Leaves every other request, and
 * any request that already has the header, alone.
 */
export function withTaskRoutingHeader(fetchFn: FetchLike): FetchLike {
  return (input, init) => {
    const taskId = routedTaskIdOf(init);
    if (taskId === undefined) return fetchFn(input, init);
    const headers = new Headers(init?.headers);
    if (headers.has('mcp-name')) return fetchFn(input, init);
    headers.set('mcp-name', encodeHeaderValue(taskId));
    return fetchFn(input, { ...init, headers });
  };
}
