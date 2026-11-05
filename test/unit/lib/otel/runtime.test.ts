/**
 * Unit tests for the `--otel` runtime: the OpenTelemetry SDK it registers exports over
 * OTLP/HTTP to the endpoint named by the standard environment variables, the caller's
 * trace context becomes the parent of the spans, and shutdown flushes what is pending.
 *
 * Registers the SDK globally for this worker; vitest isolates test files, so that is fine.
 */

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';
import { startOpenTelemetry, type OtelRuntime } from '../../../../src/lib/otel/runtime.js';
import { createNoOpLogger } from '../../../../src/lib/logger.js';

type Json = Record<string, unknown>;

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const PARENT_SPAN_ID = 'b7ad6b7169203331';

const posts: Array<{ path: string; body: Json }> = [];
let receiver: Server;
let runtime: OtelRuntime;

function attributes(list: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of (list as Json[]) ?? []) {
    const value = entry.value as Json;
    out[entry.key as string] = Object.values(value)[0];
  }
  return out;
}

function fakeTransport(): Transport & { sent: JSONRPCMessage[] } {
  const inner = {
    sent: [] as JSONRPCMessage[],
    async start() {},
    async close() {},
    async send(message: JSONRPCMessage) {
      inner.sent.push(message);
    },
  } as Transport & { sent: JSONRPCMessage[] };
  return inner;
}

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      posts.push({ path: req.url ?? '', body: JSON.parse(body || '{}') as Json });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const { port } = receiver.address() as AddressInfo;
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.OTEL_SERVICE_NAME = 'mcpc-unit';
  process.env.OTEL_RESOURCE_ATTRIBUTES = 'deployment.environment=test';
  // Spans wait for shutdown; metrics must not export on their own either
  process.env.OTEL_BSP_SCHEDULE_DELAY = '60000';
  process.env.OTEL_METRIC_EXPORT_INTERVAL = '60000';
});

afterAll(async () => {
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

describe('startOpenTelemetry', () => {
  it('parents the transport spans to the caller trace context and exports them on shutdown', async () => {
    runtime = startOpenTelemetry({ serviceVersion: '9.9.9', logger: createNoOpLogger() });
    const inner = fakeTransport();
    const transport = runtime.instrumentTransport(inner, { serverUrl: 'https://mcp.example.com' });

    await runtime.runWithTraceContext(
      {
        traceparent: `00-${TRACE_ID}-${PARENT_SPAN_ID}-01`,
        tracestate: 'vendor=abc',
        baggage: 'tenant=acme',
      },
      async () => {
        await transport.send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'echo', arguments: { message: 'hi' } },
        });
      }
    );
    inner.onmessage?.({ jsonrpc: '2.0', id: 1, result: { content: [] } });

    // The wire message carries the whole W3C context: trace, state and baggage
    const meta = (inner.sent[0] as { params: { _meta: Record<string, string> } }).params._meta;
    expect(meta.traceparent).toMatch(new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`));
    expect(meta.traceparent).not.toContain(PARENT_SPAN_ID);
    expect(meta.tracestate).toBe('vendor=abc');
    expect(meta.baggage).toContain('tenant=acme');

    // Without a carrier the function simply runs
    await expect(runtime.runWithTraceContext(undefined, async () => 42)).resolves.toBe(42);

    expect(posts).toHaveLength(0);
    await runtime.shutdown();
    await runtime.shutdown(); // idempotent

    const traces = posts.find((post) => post.path === '/v1/traces');
    expect(traces).toBeDefined();
    const resourceSpan = (traces!.body.resourceSpans as Json[])[0]!;
    expect(attributes((resourceSpan.resource as Json).attributes)).toMatchObject({
      'service.name': 'mcpc-unit',
      'service.version': '9.9.9',
      'deployment.environment': 'test',
    });
    const scopeSpan = (resourceSpan.scopeSpans as Json[])[0]!;
    expect(scopeSpan.scope).toMatchObject({ name: '@apify/mcpc', version: '9.9.9' });
    const span = (scopeSpan.spans as Json[])[0]!;
    expect(span.name).toBe('tools/call echo');
    expect(span.traceId).toBe(TRACE_ID);
    expect(span.parentSpanId).toBe(PARENT_SPAN_ID);
    expect(meta.traceparent).toContain(span.spanId as string);

    const metricsPost = posts.find((post) => post.path === '/v1/metrics');
    expect(metricsPost).toBeDefined();
    const names = (metricsPost!.body.resourceMetrics as Json[]).flatMap((rm) =>
      (rm.scopeMetrics as Json[]).flatMap((sm) => (sm.metrics as Json[]).map((m) => m.name))
    );
    expect(names).toContain('mcp.client.operation.duration');
  });

  it('registers nothing when OTEL_SDK_DISABLED is set', async () => {
    process.env.OTEL_SDK_DISABLED = 'true';
    try {
      const disabled = startOpenTelemetry({ serviceVersion: '9.9.9', logger: createNoOpLogger() });
      const inner = fakeTransport();
      expect(disabled.instrumentTransport(inner)).toBe(inner);
      await expect(
        disabled.runWithTraceContext({ traceparent: 'x' }, async () => 'ran')
      ).resolves.toBe('ran');
      await expect(disabled.shutdown()).resolves.toBeUndefined();
    } finally {
      delete process.env.OTEL_SDK_DISABLED;
    }
  });
});
