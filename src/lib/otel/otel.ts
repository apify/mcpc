/**
 * OpenTelemetry boundary module — the ONLY file in src/ allowed to import from
 * `@opentelemetry/*`.
 *
 * At build time, `scripts/bundle-otel.mjs` overwrites the tsc-compiled
 * dist/lib/otel/otel.js with a self-contained, tree-shaken esbuild bundle, so the
 * OpenTelemetry SDK can stay in devDependencies: users who never pass `--otel` download
 * nothing extra, and a bridge loads the bundle only when the flag is set. During
 * development (plain tsc / tsc --watch / vitest), the compiled re-exports resolve against
 * the installed devDependencies as usual.
 *
 * Rules for this file (same as src/lib/x402/viem.ts):
 * - No relative imports. The bundler would inline them, creating a second copy (separate
 *   module identity) of anything they define.
 * - Export only what the OpenTelemetry feature actually uses — every extra symbol grows the
 *   bundle. `scripts/bundle-otel.mjs` enforces the size and dependency invariants.
 *
 * `@opentelemetry/api` registers its global providers on `globalThis` under a versioned
 * symbol, so the copy inlined here interoperates with any other copy in the process — such
 * as the one the MCP SDK will bring once its own instrumentation ships (see
 * instrument-transport.ts).
 */
export {
  context,
  diag,
  DiagLogLevel,
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  defaultTextMapGetter,
  defaultTextMapSetter,
} from '@opentelemetry/api';
export type { Attributes, DiagLogger, Histogram, Span, Tracer } from '@opentelemetry/api';
export { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
export { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
export { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
export { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
export { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
export {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
  getBooleanFromEnv,
  getNumberFromEnv,
} from '@opentelemetry/core';
export {
  defaultResource,
  detectResources,
  envDetector,
  resourceFromAttributes,
} from '@opentelemetry/resources';
