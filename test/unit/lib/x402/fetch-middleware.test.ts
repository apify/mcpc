/**
 * Tests for the proactive-sign path and the tool-result retry path's scheme handling.
 *
 * Regression target: `--x402 exact` must not be silently overridden by the
 * proactive `_meta.x402` path or by the tool-result retry helper. Both used to
 * hard-code `auto` and pick whatever the server preferred (which now defaults to
 * `upto` after apify-mcp-server #876).
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import {
  createX402FetchMiddleware,
  extractAcceptFromPaymentRequired,
  type X402PaymentCache,
} from '../../../../src/lib/x402/fetch-middleware.js';
import type { PaymentRequiredAccept, SignerWallet } from '../../../../src/lib/x402/signer.js';

// ---------------------------------------------------------------------------
// Mocks — vi.mock is hoisted above local const declarations
// ---------------------------------------------------------------------------

const { mockSignPayment } = vi.hoisted(() => ({ mockSignPayment: vi.fn() }));

vi.mock('../../../../src/lib/x402/signer.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../src/lib/x402/signer.js')>(
    '../../../../src/lib/x402/signer.js'
  );
  return {
    ...actual,
    signPayment: (...args: unknown[]) => mockSignPayment(...args),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WALLET: SignerWallet = {
  privateKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
  address: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B',
};

const EXACT_ACCEPT: PaymentRequiredAccept = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '1000000',
  asset: '0xExactAsset',
  payTo: '0xPayee',
  maxTimeoutSeconds: 60,
  extra: { name: 'USDC', version: '2' },
};

const UPTO_ACCEPT: PaymentRequiredAccept = {
  scheme: 'upto',
  network: 'eip155:8453',
  amount: '1000000',
  asset: '0xUptoAsset',
  payTo: '0xPayee',
  maxTimeoutSeconds: 18_000,
  extra: { name: 'USDC', version: '2', facilitatorAddress: '0xFacilitator' },
};

function makePaidTool(metaX402: Record<string, unknown>): Tool {
  return {
    name: 'paid-tool',
    description: 'Paid tool',
    inputSchema: { type: 'object' },
    _meta: { x402: { paymentRequired: true, ...metaX402 } },
  } as unknown as Tool;
}

function toolsCallBody(toolName: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: toolName, arguments: {} },
  });
}

beforeEach(() => {
  mockSignPayment.mockReset();
  mockSignPayment.mockResolvedValue({
    paymentSignatureBase64: 'mock-signature-base64',
    from: WALLET.address,
    to: '0xPayee',
    amountUsd: 1,
    amountAtomicUnits: 1_000_000n,
    networkLabel: 'Base Mainnet',
    expiresAt: new Date(),
  });
});

// ---------------------------------------------------------------------------
// proactive-sign path — getOrSignPayment via createX402FetchMiddleware
// ---------------------------------------------------------------------------

describe('createX402FetchMiddleware proactive sign', () => {
  it('reuses a challenge-signed cache entry when the tool has no proactive x402 metadata', async () => {
    const cachedPayload = {
      x402Version: 2,
      payload: { signature: '0xsig', authorization: { from: WALLET.address } },
    };
    const cachedSignature = Buffer.from(JSON.stringify(cachedPayload)).toString('base64');
    // What the bridge leaves behind after a payment-required CallToolResult
    const cache: X402PaymentCache = {
      signature: cachedSignature,
      paymentRequiredTools: new Set(['paid-tool']),
    };
    const baseFetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    const fetchFn = createX402FetchMiddleware(baseFetch as never, {
      wallet: WALLET,
      getToolByName: () => undefined,
      paymentCache: cache,
      schemePreference: 'exact',
    });

    await fetchFn('https://example.test/mcp', { method: 'POST', body: toolsCallBody('paid-tool') });

    expect(mockSignPayment).not.toHaveBeenCalled();
    expect(baseFetch).toHaveBeenCalledTimes(1);
    const init = baseFetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('PAYMENT-SIGNATURE')).toBe(cachedSignature);
    const body = JSON.parse(String(init.body));
    expect(body.params._meta['x402/payment']).toEqual(cachedPayload);
  });

  it('does not attach the cached signature to a tool the server never charged for', async () => {
    const cache: X402PaymentCache = {
      signature: 'session-signature-base64',
      paymentRequiredTools: new Set(['paid-tool']),
    };
    const freeTool = {
      name: 'free-tool',
      description: 'Free tool',
      inputSchema: { type: 'object' },
    } as unknown as Tool;
    const baseFetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    const fetchFn = createX402FetchMiddleware(baseFetch as never, {
      wallet: WALLET,
      getToolByName: () => freeTool,
      paymentCache: cache,
    });

    await fetchFn('https://example.test/mcp', { method: 'POST', body: toolsCallBody('free-tool') });

    expect(mockSignPayment).not.toHaveBeenCalled();
    const init = baseFetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('PAYMENT-SIGNATURE')).toBeNull();
    expect(JSON.parse(String(init.body)).params._meta).toBeUndefined();
  });

  it('does not attach the cached signature to a tool missing from the tools cache', async () => {
    const cache: X402PaymentCache = {
      signature: 'session-signature-base64',
      paymentRequiredTools: new Set(['paid-tool']),
    };
    const baseFetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    const fetchFn = createX402FetchMiddleware(baseFetch as never, {
      wallet: WALLET,
      getToolByName: () => undefined,
      paymentCache: cache,
    });

    await fetchFn('https://example.test/mcp', {
      method: 'POST',
      body: toolsCallBody('unknown-tool'),
    });

    const init = baseFetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('PAYMENT-SIGNATURE')).toBeNull();
  });

  it('with schemePreference=exact and accepts=[exact, upto], signs exact', async () => {
    const tool = makePaidTool({ accepts: [EXACT_ACCEPT, UPTO_ACCEPT], ...UPTO_ACCEPT });
    const cache: X402PaymentCache = { signature: null };
    const fetchFn = createX402FetchMiddleware(
      vi.fn().mockResolvedValue(new Response('', { status: 200 })),
      {
        wallet: WALLET,
        getToolByName: () => tool,
        paymentCache: cache,
        schemePreference: 'exact',
      }
    );

    await fetchFn('https://example.test/mcp', { method: 'POST', body: toolsCallBody('paid-tool') });

    expect(mockSignPayment).toHaveBeenCalledTimes(1);
    const accept = mockSignPayment.mock.calls[0]?.[0]?.accept as PaymentRequiredAccept;
    expect(accept.scheme).toBe('exact');
    expect(accept.asset).toBe('0xExactAsset');
  });

  it('with schemePreference=upto and accepts=[exact, upto], signs upto', async () => {
    const tool = makePaidTool({ accepts: [EXACT_ACCEPT, UPTO_ACCEPT], ...EXACT_ACCEPT });
    const cache: X402PaymentCache = { signature: null };
    const fetchFn = createX402FetchMiddleware(
      vi.fn().mockResolvedValue(new Response('', { status: 200 })),
      {
        wallet: WALLET,
        getToolByName: () => tool,
        paymentCache: cache,
        schemePreference: 'upto',
      }
    );

    await fetchFn('https://example.test/mcp', { method: 'POST', body: toolsCallBody('paid-tool') });

    const accept = mockSignPayment.mock.calls[0]?.[0]?.accept as PaymentRequiredAccept;
    expect(accept.scheme).toBe('upto');
    expect(accept.asset).toBe('0xUptoAsset');
  });

  it('with schemePreference=exact and accepts=[upto] only, skips proactive sign', async () => {
    const tool = makePaidTool({ accepts: [UPTO_ACCEPT], ...UPTO_ACCEPT });
    const cache: X402PaymentCache = { signature: null };
    const baseFetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    const fetchFn = createX402FetchMiddleware(baseFetch as never, {
      wallet: WALLET,
      getToolByName: () => tool,
      paymentCache: cache,
      schemePreference: 'exact',
    });

    await fetchFn('https://example.test/mcp', { method: 'POST', body: toolsCallBody('paid-tool') });

    expect(mockSignPayment).not.toHaveBeenCalled();
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it('with schemePreference=exact and legacy flat-only _meta.x402 advertising upto, defers to 402 fallback', async () => {
    // Pre-#876 server: flat fields only, no accepts[]. Server's preferred scheme is upto.
    const tool = makePaidTool({ ...UPTO_ACCEPT });
    const cache: X402PaymentCache = { signature: null };
    const baseFetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    const fetchFn = createX402FetchMiddleware(baseFetch as never, {
      wallet: WALLET,
      getToolByName: () => tool,
      paymentCache: cache,
      schemePreference: 'exact',
    });

    await fetchFn('https://example.test/mcp', { method: 'POST', body: toolsCallBody('paid-tool') });

    expect(mockSignPayment).not.toHaveBeenCalled();
  });

  it('with schemePreference=auto and accepts=[exact, upto], prefers upto', async () => {
    const tool = makePaidTool({ accepts: [EXACT_ACCEPT, UPTO_ACCEPT], ...UPTO_ACCEPT });
    const cache: X402PaymentCache = { signature: null };
    const fetchFn = createX402FetchMiddleware(
      vi.fn().mockResolvedValue(new Response('', { status: 200 })),
      {
        wallet: WALLET,
        getToolByName: () => tool,
        paymentCache: cache,
        // schemePreference unset → defaults to auto
      }
    );

    await fetchFn('https://example.test/mcp', { method: 'POST', body: toolsCallBody('paid-tool') });

    const accept = mockSignPayment.mock.calls[0]?.[0]?.accept as PaymentRequiredAccept;
    expect(accept.scheme).toBe('upto');
  });
});

// ---------------------------------------------------------------------------
// HTTP 402 fallback path
// ---------------------------------------------------------------------------

describe('createX402FetchMiddleware HTTP 402 fallback', () => {
  const paymentRequiredHeader = Buffer.from(
    JSON.stringify({ x402Version: 2, accepts: [EXACT_ACCEPT] })
  ).toString('base64');

  it('remembers the charged tool, so the next call to it reuses the signature', async () => {
    const cache: X402PaymentCache = { signature: null };
    const baseFetch = vi
      .fn()
      // First call: unpaid, server demands payment
      .mockResolvedValueOnce(
        new Response('', { status: 402, headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader } })
      )
      .mockResolvedValue(new Response('', { status: 200 }));
    const fetchFn = createX402FetchMiddleware(baseFetch as never, {
      wallet: WALLET,
      // Challenge-first server: nothing advertised in tools/list
      getToolByName: () => undefined,
      paymentCache: cache,
    });

    await fetchFn('https://example.test/mcp', { method: 'POST', body: toolsCallBody('paid-tool') });
    expect(cache.paymentRequiredTools?.has('paid-tool')).toBe(true);

    // Second call to the same tool goes out paid without signing again
    await fetchFn('https://example.test/mcp', { method: 'POST', body: toolsCallBody('paid-tool') });

    expect(mockSignPayment).toHaveBeenCalledTimes(1);
    expect(baseFetch).toHaveBeenCalledTimes(3);
    const init = baseFetch.mock.calls[2]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('PAYMENT-SIGNATURE')).toBe('mock-signature-base64');
  });
});

// ---------------------------------------------------------------------------
// tool-result retry path — extractAcceptFromPaymentRequired
// ---------------------------------------------------------------------------

describe('extractAcceptFromPaymentRequired', () => {
  const paymentRequired = {
    x402Version: 2,
    accepts: [EXACT_ACCEPT, UPTO_ACCEPT],
    resource: { url: 'mcp://tool/foo', description: 'foo' },
  };

  it('defaults to auto (prefers upto) when schemePreference is omitted', () => {
    const result = extractAcceptFromPaymentRequired(paymentRequired);
    expect(result?.accept.scheme).toBe('upto');
  });

  it('honors schemePreference=exact', () => {
    const result = extractAcceptFromPaymentRequired(paymentRequired, 'exact');
    expect(result?.accept.scheme).toBe('exact');
  });

  it('honors schemePreference=upto', () => {
    const result = extractAcceptFromPaymentRequired(paymentRequired, 'upto');
    expect(result?.accept.scheme).toBe('upto');
  });

  it('returns undefined when schemePreference=exact and only upto is available', () => {
    const uptoOnly = { x402Version: 2, accepts: [UPTO_ACCEPT] };
    const result = extractAcceptFromPaymentRequired(uptoOnly, 'exact');
    expect(result).toBeUndefined();
  });
});
