/**
 * Unit tests for the OpenTelemetry transport instrumentation: one CLIENT span and one
 * duration measurement per outbound request/notification, W3C trace context injected into
 * `params._meta`, and the outcome mapping (JSON-RPC errors, tool errors, cancellation,
 * send failures, connection loss).
 *
 * Uses the real OpenTelemetry SDK with in-memory exporters, registered globally once for
 * this worker (vitest isolates test files, so the globals are ours alone).
 */

import { context, metrics, propagation, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import type { JSONRPCMessage, Transport, TransportSendOptions } from '@modelcontextprotocol/client';
import {
  DURATION_METRIC_NAME,
  INSTRUMENTATION_SCOPE,
  instrumentTransport,
} from '../../../../src/lib/otel/instrument-transport.js';

const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;

const spanExporter = new InMemorySpanExporter();
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 60_000,
});
const tracerProvider = new TracerProvider({
  spanProcessors: [new SimpleSpanProcessor({ exporter: spanExporter })],
});
const meterProvider = new MeterProvider({ readers: [metricReader] });

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(tracerProvider);
  metrics.setGlobalMeterProvider(meterProvider);
});

afterAll(async () => {
  await tracerProvider.shutdown();
  await meterProvider.shutdown();
  trace.disable();
  metrics.disable();
  propagation.disable();
  context.disable();
});

beforeEach(() => {
  spanExporter.reset();
});

interface FakeTransport extends Transport {
  sent: Array<{ message: JSONRPCMessage; options?: TransportSendOptions }>;
  failWith?: Error;
  protocolVersions: string[];
  terminateSession: () => Promise<void>;
}

function fakeTransport(): FakeTransport {
  const inner: FakeTransport = {
    sent: [],
    protocolVersions: [],
    sessionId: 'sess-1',
    async start() {},
    async close() {
      inner.onclose?.();
    },
    async send(message, options) {
      if (inner.failWith) throw inner.failWith;
      inner.sent.push({ message, ...(options && { options }) });
    },
    setProtocolVersion(version: string) {
      inner.protocolVersions.push(version);
    },
    async terminateSession() {},
  };
  return inner;
}

/** Deliver an inbound message the way the real transport would (through the wrapped one). */
function receive(inner: Transport, message: JSONRPCMessage): void {
  inner.onmessage?.(message);
}

function finishedSpans() {
  return spanExporter.getFinishedSpans();
}

function attributesOf(message: JSONRPCMessage): Record<string, unknown> {
  return ((message as { params?: { _meta?: Record<string, unknown> } }).params?._meta ??
    {}) as Record<string, unknown>;
}

/** Every duration data point exported so far, across instrumentation-scope versions. */
async function collectedPoints() {
  await metricReader.forceFlush();
  const [resourceMetrics] = metricExporter.getMetrics().slice(-1);
  const histograms = (resourceMetrics?.scopeMetrics ?? [])
    .flatMap((scope) => scope.metrics)
    .filter((metric) => metric.descriptor.name === DURATION_METRIC_NAME);
  return { histogram: histograms[0], points: histograms.flatMap((metric) => metric.dataPoints) };
}

describe('instrumentTransport', () => {
  it('traces a request as a CLIENT span under the active context and injects _meta', async () => {
    const inner = fakeTransport();
    const transport = instrumentTransport(inner, {
      serverUrl: 'https://mcp.example.com/mcp',
      scopeVersion: '1.2.3',
    });
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => received.push(message);

    const parent = trace.getTracer('test').startSpan('invoke_agent');
    const request: JSONRPCMessage = {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'get-weather',
        arguments: { city: 'Prague' },
        _meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', progressToken: 'p1' },
      },
    };
    await context.with(trace.setSpan(context.active(), parent), () => transport.send(request));

    // The wire message carries the span's trace context, on top of the existing _meta
    expect(inner.sent).toHaveLength(1);
    const sent = inner.sent[0]!.message;
    const meta = attributesOf(sent);
    const match = TRACEPARENT_PATTERN.exec(String(meta.traceparent));
    expect(match).not.toBeNull();
    expect(match![1]).toBe(parent.spanContext().traceId);
    expect(meta[PROTOCOL_VERSION_META_KEY]).toBe('2026-07-28');
    expect(meta.progressToken).toBe('p1');
    // ...without mutating the message the SDK handed over
    expect(attributesOf(request).traceparent).toBeUndefined();
    expect((sent as { params: { arguments: unknown } }).params.arguments).toEqual({
      city: 'Prague',
    });

    // Nothing is finished until the response arrives
    expect(finishedSpans()).toHaveLength(0);
    receive(inner, {
      jsonrpc: '2.0',
      id: 7,
      result: { content: [{ type: 'text', text: 'sunny' }] },
    });
    expect(received).toHaveLength(1);

    const [span] = finishedSpans();
    expect(span!.name).toBe('tools/call get-weather');
    expect(span!.kind).toBe(SpanKind.CLIENT);
    expect(span!.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(span!.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(span!.spanContext().spanId).toBe(match![2]);
    expect(span!.status.code).toBe(SpanStatusCode.UNSET);
    expect(span!.instrumentationScope).toMatchObject({
      name: INSTRUMENTATION_SCOPE,
      version: '1.2.3',
    });
    expect(span!.attributes).toEqual({
      'mcp.method.name': 'tools/call',
      'mcp.protocol.version': '2026-07-28',
      'mcp.session.id': 'sess-1',
      'jsonrpc.request.id': '7',
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'get-weather',
      'server.address': 'mcp.example.com',
      'server.port': 443,
      'network.transport': 'tcp',
      'network.protocol.name': 'http',
    });
    parent.end();
  });

  it('records a JSON-RPC error response as an error', async () => {
    const inner = fakeTransport();
    const transport = instrumentTransport(inner);
    await transport.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: { uri: 'file:///x' },
    });
    receive(inner, {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32002, message: 'Resource not found: file:///x' },
    });

    const [span] = finishedSpans();
    expect(span!.name).toBe('resources/read');
    expect(span!.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'Resource not found: file:///x',
    });
    expect(span!.attributes).toMatchObject({
      'mcp.resource.uri': 'file:///x',
      'error.type': '-32002',
      'rpc.response.status_code': '-32002',
      'network.transport': 'pipe',
    });
    expect(span!.attributes['server.address']).toBeUndefined();
  });

  it('records a tool result with isError as tool_error', async () => {
    const inner = fakeTransport();
    const transport = instrumentTransport(inner);
    await transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fail' } });
    receive(inner, { jsonrpc: '2.0', id: 2, result: { content: [], isError: true } });
    const [span] = finishedSpans();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.attributes['error.type']).toBe('tool_error');

    // isError on anything but tools/call is just data
    spanExporter.reset();
    await transport.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
    receive(inner, { jsonrpc: '2.0', id: 3, result: { isError: true } });
    expect(finishedSpans()[0]!.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records a send failure with the SDK error code and rethrows', async () => {
    const inner = fakeTransport();
    const transport = instrumentTransport(inner);
    inner.failWith = Object.assign(new Error('Error POSTing to endpoint'), { code: 'HTTP_ERROR' });
    await expect(transport.send({ jsonrpc: '2.0', id: 4, method: 'tools/list' })).rejects.toThrow(
      'Error POSTing to endpoint'
    );
    const [span] = finishedSpans();
    expect(span!.attributes['error.type']).toBe('HTTP_ERROR');
    expect(span!.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: 'Error POSTing to endpoint',
    });
    expect(span!.events.map((event) => event.name)).toContain('exception');

    inner.failWith = new Error('boom');
    spanExporter.reset();
    await expect(transport.send({ jsonrpc: '2.0', id: 5, method: 'tools/list' })).rejects.toThrow(
      'boom'
    );
    expect(finishedSpans()[0]!.attributes['error.type']).toBe('SEND_FAILED');
  });

  it('ends a withdrawn request when the SDK sends notifications/cancelled', async () => {
    const inner = fakeTransport();
    const transport = instrumentTransport(inner);
    await transport.send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'slow' } });
    await transport.send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'slow' } });
    await transport.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 8, reason: 'Request timed out' },
    });
    await transport.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 9, reason: 'User aborted' },
    });

    const byName = Object.fromEntries(
      finishedSpans().map((span) => [
        `${span.name}#${span.attributes['jsonrpc.request.id'] ?? ''}`,
        span,
      ])
    );
    expect(byName['tools/call slow#8']!.attributes['error.type']).toBe('timeout');
    expect(byName['tools/call slow#9']!.attributes['error.type']).toBe('cancelled');
    // The notifications themselves are traced too (and carry the trace context)
    const notifications = finishedSpans().filter((span) => span.name === 'notifications/cancelled');
    expect(notifications).toHaveLength(2);
    expect(notifications[0]!.status.code).toBe(SpanStatusCode.UNSET);
    expect(attributesOf(inner.sent[2]!.message).traceparent).toMatch(TRACEPARENT_PATTERN);
  });

  it('ends a request whose per-request stream the SDK aborts', async () => {
    const inner = fakeTransport();
    const transport = instrumentTransport(inner);
    const abort = new AbortController();
    await transport.send(
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'slow' } },
      { requestSignal: abort.signal }
    );
    expect(finishedSpans()).toHaveLength(0);
    abort.abort();
    expect(finishedSpans()[0]!.attributes['error.type']).toBe('cancelled');
    // A late response for the same id is ignored, not double-ended
    receive(inner, { jsonrpc: '2.0', id: 10, result: {} });
    expect(finishedSpans()).toHaveLength(1);
  });

  it('ends every pending request when the connection closes', async () => {
    const inner = fakeTransport();
    const transport = instrumentTransport(inner);
    const closed = vi.fn();
    transport.onclose = closed;
    await transport.send({ jsonrpc: '2.0', id: 11, method: 'tools/list' });
    await transport.send({ jsonrpc: '2.0', id: 12, method: 'prompts/list' });
    await inner.close();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(finishedSpans().map((span) => span.attributes['error.type'])).toEqual([
      'connection_closed',
      'connection_closed',
    ]);
  });

  it('records the negotiated protocol version reported through setProtocolVersion', async () => {
    const inner = fakeTransport();
    const transport = instrumentTransport(inner);
    transport.setProtocolVersion?.('2025-11-25');
    expect(inner.protocolVersions).toEqual(['2025-11-25']);
    await transport.send({
      jsonrpc: '2.0',
      id: 13,
      method: 'prompts/get',
      params: { name: 'greet' },
    });
    receive(inner, { jsonrpc: '2.0', id: 13, result: { messages: [] } });
    const [span] = finishedSpans();
    expect(span!.name).toBe('prompts/get greet');
    expect(span!.attributes).toMatchObject({
      'mcp.protocol.version': '2025-11-25',
      'gen_ai.prompt.name': 'greet',
    });
    expect(span!.attributes['gen_ai.operation.name']).toBeUndefined();
  });

  it('forwards everything else to the wrapped transport', async () => {
    const inner = fakeTransport();
    const transport = instrumentTransport(inner);
    expect(transport.sessionId).toBe('sess-1');
    expect(typeof (transport as FakeTransport).terminateSession).toBe('function');
    expect('terminateSession' in transport).toBe(true);
    const onerror = vi.fn();
    transport.onerror = onerror;
    inner.onerror?.(new Error('transport error'));
    expect(onerror).toHaveBeenCalledWith(new Error('transport error'));
    expect(transport.onerror).toBe(onerror);
    // Responses to server-initiated requests pass through untouched and untraced
    const response: JSONRPCMessage = { jsonrpc: '2.0', id: 99, result: { roots: [] } };
    await transport.send(response);
    expect(inner.sent[0]!.message).toBe(response);
    expect(finishedSpans()).toHaveLength(0);
  });

  it('measures every operation with low-cardinality attributes', async () => {
    const inner = fakeTransport();
    const transport = instrumentTransport(inner, { serverUrl: 'http://localhost:8080' });
    await transport.send({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'echo' },
    });
    receive(inner, { jsonrpc: '2.0', id: 20, result: { content: [] } });
    await transport.send({
      jsonrpc: '2.0',
      id: 21,
      method: 'x/custom',
      params: { uri: 'file:///y' },
    });
    receive(inner, {
      jsonrpc: '2.0',
      id: 21,
      error: { code: -32601, message: 'Method not found' },
    });

    const { histogram, points } = await collectedPoints();
    expect(histogram?.descriptor).toMatchObject({ unit: 's' });
    // The reader is cumulative across this file's tests: pick this test's points by their
    // own attributes
    const echoPoint = points.find((point) => point.attributes['gen_ai.tool.name'] === 'echo');
    expect(echoPoint?.attributes).toEqual({
      'mcp.method.name': 'tools/call',
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'echo',
      'server.address': 'localhost',
      'server.port': 8080,
      'network.transport': 'tcp',
      'network.protocol.name': 'http',
    });
    // Unknown methods are bucketed, errors are an attribute, URIs and ids never appear
    const otherPoint = points.find((point) => point.attributes['mcp.method.name'] === '_OTHER');
    expect(otherPoint?.attributes).toMatchObject({ 'error.type': '-32601' });
    expect(otherPoint?.attributes['mcp.resource.uri']).toBeUndefined();
    const value = echoPoint!.value as { buckets: { boundaries: number[] }; count: number };
    expect(value.count).toBe(1);
    expect(value.buckets.boundaries).toEqual([
      0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300,
    ]);
  });

  it('leaves _meta untouched when no SDK is registered', async () => {
    trace.disable();
    try {
      const inner = fakeTransport();
      const transport = instrumentTransport(inner);
      const request: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: { name: 'echo', _meta: { progressToken: 'p' } },
      };
      await transport.send(request);
      expect(inner.sent[0]!.message).toEqual(request);
      receive(inner, { jsonrpc: '2.0', id: 30, result: {} });
    } finally {
      trace.setGlobalTracerProvider(tracerProvider);
    }
  });
});
