/**
 * W3C Trace Context handed to mcpc by its caller, as environment variables.
 *
 * `TRACEPARENT`, `TRACESTATE` and `BAGGAGE` are the established convention for passing a
 * trace to a child process (OpenTelemetry's environment-variable carrier, as used by
 * otel-cli and the CI tracing plugins). The CLI reads them on every invocation and sends
 * them to the bridge with the IPC request, so the MCP spans an `--otel` session emits join
 * the caller's trace instead of starting new ones, and the server sees the same trace in
 * `_meta.traceparent` (SEP-414).
 *
 * Dependency-free on purpose: the CLI imports this on every command, while the
 * OpenTelemetry SDK itself is loaded only by a bridge started with `--otel`.
 */

/** The three W3C propagation headers, keyed exactly as `_meta` and the environment carry them. */
export interface TraceContextCarrier {
  traceparent: string;
  tracestate?: string;
  baggage?: string;
}

/** `version-traceId-parentId-flags`, lowercase hex, as the W3C Trace Context spec writes it. */
const TRACEPARENT_PATTERN = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** Longest `tracestate` / `baggage` value forwarded (the W3C Baggage size limit). */
const MAX_PROPAGATION_VALUE_CHARS = 8192;

/**
 * Read the caller's trace context from the environment. Returns undefined unless
 * `TRACEPARENT` is set and well-formed; `TRACESTATE` and `BAGGAGE` ride along when present.
 */
export function readTraceContextFromEnv(
  env: NodeJS.ProcessEnv = process.env
): TraceContextCarrier | undefined {
  const traceparent = env.TRACEPARENT?.trim();
  if (!traceparent || !TRACEPARENT_PATTERN.test(traceparent)) return undefined;

  const carrier: TraceContextCarrier = { traceparent };
  const tracestate = optionalValue(env.TRACESTATE);
  if (tracestate) carrier.tracestate = tracestate;
  const baggage = optionalValue(env.BAGGAGE);
  if (baggage) carrier.baggage = baggage;
  return carrier;
}

/**
 * Validate a carrier that arrived over IPC (untrusted JSON written by another process):
 * the same rules as the environment reader, applied to the message fields.
 */
export function sanitizeTraceContext(value: unknown): TraceContextCarrier | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return readTraceContextFromEnv({
    TRACEPARENT: asString(record.traceparent),
    TRACESTATE: asString(record.tracestate),
    BAGGAGE: asString(record.baggage),
  });
}

function optionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > MAX_PROPAGATION_VALUE_CHARS) return undefined;
  return trimmed;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
