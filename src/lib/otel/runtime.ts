/**
 * The OpenTelemetry SDK a `--otel` bridge registers: tracer and meter providers exporting
 * over OTLP/HTTP (JSON), an AsyncLocalStorage context manager, and the W3C trace-context +
 * baggage propagator — the same setup `@opentelemetry/sdk-node` performs, minus the
 * automatic library instrumentation and the gRPC exporters that would multiply the bundle.
 *
 * Configuration follows the standard `OTEL_*` environment variables, read by the SDK
 * packages themselves: `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://localhost:4318`),
 * `OTEL_EXPORTER_OTLP_HEADERS`, the `_TRACES_` / `_METRICS_` signal-specific variants,
 * `OTEL_SERVICE_NAME` (default `mcpc`), `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_TRACES_SAMPLER`,
 * `OTEL_BSP_*`, `OTEL_METRIC_EXPORT_INTERVAL` and `OTEL_SDK_DISABLED`. The bridge inherits
 * them from the CLI invocation that spawned it.
 *
 * Loaded lazily by the bridge (`await import`) so sessions without `--otel` never pay for
 * the bundled SDK; see otel.ts for the bundling rules.
 */

import type { Transport } from '@modelcontextprotocol/client';
import type { Logger } from '../logger.js';
import type { TraceContextCarrier } from '../trace-context.js';
import { instrumentTransport, type InstrumentTransportOptions } from './instrument-transport.js';
import {
  AsyncLocalStorageContextManager,
  BatchSpanProcessor,
  CompositePropagator,
  DiagLogLevel,
  MeterProvider,
  OTLPMetricExporter,
  OTLPTraceExporter,
  PeriodicExportingMetricReader,
  ROOT_CONTEXT,
  TracerProvider,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
  context,
  defaultResource,
  defaultTextMapGetter,
  detectResources,
  diag,
  envDetector,
  getBooleanFromEnv,
  getNumberFromEnv,
  metrics,
  propagation,
  resourceFromAttributes,
  trace,
  type DiagLogger,
} from './otel.js';

/** Metric export cadence when `OTEL_METRIC_EXPORT_INTERVAL` is unset (the SDK default). */
const DEFAULT_METRIC_EXPORT_INTERVAL_MILLIS = 60_000;

/**
 * Upper bound on the final flush at shutdown. The OTLP exporters have their own request
 * timeout, but a collector that accepts the connection and never answers must not hold a
 * closing bridge hostage.
 */
const SHUTDOWN_TIMEOUT_MILLIS = 5_000;

export interface StartOpenTelemetryOptions {
  /** mcpc's version, reported as `service.version` and on the instrumentation scope. */
  serviceVersion: string;
  /** Receives the SDK's own diagnostics (export failures and the like). */
  logger: Logger;
}

export interface OtelRuntime {
  /**
   * Run `fn` with the given W3C trace context as the active context, so spans started
   * inside it (including the transport's) become children of the caller's span. Without a
   * carrier `fn` runs as is.
   */
  runWithTraceContext<T>(
    carrier: TraceContextCarrier | undefined,
    fn: () => Promise<T>
  ): Promise<T>;
  /** Trace and measure every message the transport sends (see instrument-transport.ts). */
  instrumentTransport(transport: Transport, options?: InstrumentTransportOptions): Transport;
  /** Flush pending spans and metrics and release the exporters. Idempotent. */
  shutdown(): Promise<void>;
}

/**
 * Register the OpenTelemetry SDK globally for this process and return the handle the
 * bridge drives it through. Honors `OTEL_SDK_DISABLED=true` by registering nothing.
 */
export function startOpenTelemetry(options: StartOpenTelemetryOptions): OtelRuntime {
  const { serviceVersion, logger } = options;

  diag.setLogger(diagLoggerFor(logger), DiagLogLevel.WARN);

  if (getBooleanFromEnv('OTEL_SDK_DISABLED')) {
    logger.warn('OTEL_SDK_DISABLED is set: --otel records and exports nothing');
    return {
      runWithTraceContext: (_carrier, fn) => fn(),
      instrumentTransport: (transport) => transport,
      shutdown: async () => {},
    };
  }

  // `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES` (envDetector) override mcpc's defaults.
  const resource = defaultResource()
    .merge(resourceFromAttributes({ 'service.name': 'mcpc', 'service.version': serviceVersion }))
    .merge(detectResources({ detectors: [envDetector] }));

  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })],
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis:
          getNumberFromEnv('OTEL_METRIC_EXPORT_INTERVAL') ?? DEFAULT_METRIC_EXPORT_INTERVAL_MILLIS,
      }),
    ],
  });

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    })
  );
  trace.setGlobalTracerProvider(tracerProvider);
  metrics.setGlobalMeterProvider(meterProvider);

  let shutdownPromise: Promise<void> | undefined;

  return {
    runWithTraceContext: (carrier, fn) => {
      if (!carrier) return fn();
      const parent = propagation.extract(ROOT_CONTEXT, carrier, defaultTextMapGetter);
      return context.with(parent, fn);
    },

    instrumentTransport: (transport, instrumentOptions = {}) =>
      instrumentTransport(transport, { scopeVersion: serviceVersion, ...instrumentOptions }),

    shutdown: () => {
      shutdownPromise ??= (async () => {
        const flush = Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]);
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT_MILLIS);
          timer.unref();
        });
        try {
          const outcome = await Promise.race([flush, timeout]);
          if (outcome === 'timeout') {
            logger.warn(
              `OpenTelemetry export did not finish within ${SHUTDOWN_TIMEOUT_MILLIS / 1000}s, giving up`
            );
          }
        } finally {
          clearTimeout(timer);
        }
      })();
      return shutdownPromise;
    },
  };
}

/** Route the SDK's diagnostics into the bridge log: problems as warnings, the rest as debug. */
function diagLoggerFor(logger: Logger): DiagLogger {
  const prefixed = (message: string): string => `OpenTelemetry: ${message}`;
  return {
    error: (message, ...args) => logger.warn(prefixed(message), ...args),
    warn: (message, ...args) => logger.warn(prefixed(message), ...args),
    info: (message, ...args) => logger.debug(prefixed(message), ...args),
    debug: (message, ...args) => logger.debug(prefixed(message), ...args),
    verbose: (message, ...args) => logger.debug(prefixed(message), ...args),
  };
}
