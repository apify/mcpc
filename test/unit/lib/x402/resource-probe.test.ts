import {
  probeHttpResource,
  X402_RESOURCE_PROBE_TIMEOUT_MS,
} from '../../../../src/lib/x402/resource-probe.js';

function jsonResponse(status: number): Response {
  return new Response('ok', { status });
}

describe('probeHttpResource', () => {
  it('skips when resource URL is missing', async () => {
    const fetchFn = vi.fn();
    await expect(probeHttpResource(undefined, { fetch: fetchFn })).resolves.toBe('skipped');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips non-http resource URLs', async () => {
    const fetchFn = vi.fn();
    await expect(probeHttpResource('mcp://tool/paid', { fetch: fetchFn })).resolves.toBe('skipped');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips when the resource is the URL we already got a 402 from', async () => {
    const fetchFn = vi.fn();
    await expect(
      probeHttpResource('https://mcp.apify.com/mcp?session=1', {
        fetch: fetchFn,
        alreadyReachedUrl: 'https://mcp.apify.com/mcp',
      })
    ).resolves.toBe('skipped');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('treats HTTP 402 as reachable (a host answered)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(402));
    await expect(probeHttpResource('https://ghost.test/v1/ping', { fetch: fetchFn })).resolves.toBe(
      'reachable'
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('treats HTTP 200 as reachable', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200));
    await expect(probeHttpResource('https://live.test/pay', { fetch: fetchFn })).resolves.toBe(
      'reachable'
    );
  });

  it('returns unreachable on DNS / connection failure', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(probeHttpResource('https://dead.test/pay', { fetch: fetchFn })).resolves.toBe(
      'unreachable'
    );
  });

  it('returns unreachable when the probe times out', async () => {
    const fetchFn = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });
    await expect(
      probeHttpResource('https://hang.test/pay', { fetch: fetchFn, timeoutMs: 20 })
    ).resolves.toBe('unreachable');
  });

  it('exposes a 5s default probe budget', () => {
    expect(X402_RESOURCE_PROBE_TIMEOUT_MS).toBe(5_000);
  });
});
