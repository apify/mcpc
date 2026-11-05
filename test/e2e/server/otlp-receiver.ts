/**
 * Minimal OTLP/HTTP (JSON) receiver for E2E tests of `mcpc connect --otel`.
 *
 * Accepts what the OpenTelemetry OTLP/HTTP exporters POST (`/v1/traces`, `/v1/metrics`)
 * and keeps it in memory, flattened so a shell test can query it with jq.
 *
 * Outputs to stdout once ready:
 *   OTLP_PORT=<port>
 *
 * Control API (same port):
 *   GET  /control/spans   → { spans: [{ name, traceId, spanId, parentSpanId, kind,
 *                            status: { code, message }, attributes: {...}, resource: {...},
 *                            scope: { name, version } }] }
 *   GET  /control/metrics → { points: [{ name, unit, attributes: {...}, count,
 *                            explicitBounds: [...] }] }
 *   POST /control/reset   → forget everything received so far
 */

import { createServer, type IncomingMessage } from 'http';

type Json = Record<string, unknown>;

interface FlatSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: number;
  status: { code: number; message?: string };
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
  scope: { name?: string; version?: string };
}

interface FlatPoint {
  name: string;
  unit?: string;
  attributes: Record<string, unknown>;
  count?: number;
  explicitBounds?: number[];
}

const spans: FlatSpan[] = [];
const points: FlatPoint[] = [];

/** OTLP JSON attributes `[{ key, value: { stringValue | intValue | ... } }]` → plain object. */
function flattenAttributes(list: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(list)) return out;
  for (const entry of list as Json[]) {
    const value = entry.value as Json | undefined;
    if (typeof entry.key !== 'string' || !value) continue;
    const [raw] = Object.values(value);
    out[entry.key] = typeof raw === 'string' && 'intValue' in value ? Number(raw) : raw;
  }
  return out;
}

function ingestTraces(body: Json): void {
  for (const rs of (body.resourceSpans as Json[] | undefined) ?? []) {
    const resource = flattenAttributes((rs.resource as Json | undefined)?.attributes);
    for (const ss of (rs.scopeSpans as Json[] | undefined) ?? []) {
      const scope = (ss.scope as Json | undefined) ?? {};
      for (const span of (ss.spans as Json[] | undefined) ?? []) {
        spans.push({
          name: String(span.name),
          traceId: String(span.traceId),
          spanId: String(span.spanId),
          ...(span.parentSpanId ? { parentSpanId: String(span.parentSpanId) } : {}),
          kind: Number(span.kind ?? 0),
          status: (span.status as FlatSpan['status'] | undefined) ?? { code: 0 },
          attributes: flattenAttributes(span.attributes),
          resource,
          scope: { name: scope.name as string, version: scope.version as string },
        });
      }
    }
  }
}

function ingestMetrics(body: Json): void {
  for (const rm of (body.resourceMetrics as Json[] | undefined) ?? []) {
    for (const sm of (rm.scopeMetrics as Json[] | undefined) ?? []) {
      for (const metric of (sm.metrics as Json[] | undefined) ?? []) {
        const histogram = metric.histogram as Json | undefined;
        for (const dp of (histogram?.dataPoints as Json[] | undefined) ?? []) {
          points.push({
            name: String(metric.name),
            ...(typeof metric.unit === 'string' ? { unit: metric.unit } : {}),
            attributes: flattenAttributes(dp.attributes),
            ...(dp.count !== undefined ? { count: Number(dp.count) } : {}),
            ...(Array.isArray(dp.explicitBounds)
              ? { explicitBounds: (dp.explicitBounds as number[]).map(Number) }
              : {}),
          });
        }
      }
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  try {
    if (
      req.method === 'POST' &&
      (url.pathname === '/v1/traces' || url.pathname === '/v1/metrics')
    ) {
      const body = JSON.parse((await readBody(req)) || '{}') as Json;
      if (url.pathname === '/v1/traces') ingestTraces(body);
      else ingestMetrics(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/control/spans') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ spans }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/control/metrics') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ points }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/control/reset') {
      spans.length = 0;
      points.length = 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(error) }));
  }
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as import('net').AddressInfo).port;

// Signal readiness to the bash framework
process.stdout.write(`OTLP_PORT=${port}\n`);

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
