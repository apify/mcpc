/**
 * Liveness probe for an x402 PAYMENT-REQUIRED `resource.url`.
 *
 * HTTP 402 means "pay me" — not "I exist." Ghost bazaar URLs still return 402
 * (or a cached PAYMENT-REQUIRED) while the host is gone. Signing before that
 * check settles against a dead resource.
 *
 * Fail closed on timeout / DNS / connection errors. Any HTTP status, including
 * 402, means a host answered and payment may proceed.
 */

export const X402_RESOURCE_PROBE_TIMEOUT_MS = 5_000;

export type ResourceProbeResult = 'reachable' | 'unreachable' | 'skipped';

export interface ProbeHttpResourceOptions {
  /** Injected fetch (tests). Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * URL we already got an HTTP response from (the 402 itself). If it matches
   * `resource.url`, skip the extra round-trip.
   */
  alreadyReachedUrl?: string;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function sameHttpTarget(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

/**
 * Probe `resourceUrl` before signing an x402 payment.
 *
 * - `skipped` — no http(s) URL, or we already reached the same target
 * - `reachable` — the host returned any HTTP status
 * - `unreachable` — timeout, DNS, or connection failure; do not sign
 */
export async function probeHttpResource(
  resourceUrl: string | undefined,
  options: ProbeHttpResourceOptions = {}
): Promise<ResourceProbeResult> {
  if (!resourceUrl || !isHttpUrl(resourceUrl)) {
    return 'skipped';
  }
  if (options.alreadyReachedUrl && sameHttpTarget(resourceUrl, options.alreadyReachedUrl)) {
    return 'skipped';
  }

  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? X402_RESOURCE_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(resourceUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { Accept: '*/*' },
    });
    // Status is irrelevant — 402/404/500 all mean a host answered.
    await response.body?.cancel();
    return 'reachable';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}
