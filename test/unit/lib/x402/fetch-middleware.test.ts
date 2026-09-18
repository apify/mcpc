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
  withSettlementReceipt,
  type X402PaymentCache,
} from '../../../../src/lib/x402/fetch-middleware.js';
import type { PaymentRequiredAccept, SignerWallet } from '../../../../src/lib/x402/signer.js';
import { X402PaymentLimitError } from '../../../../src/lib/x402/limits.js';
import { runWithPaymentLimit } from '../../../../src/lib/x402/payment-scope.js';

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

  it('fails the call instead of sending it unpaid when the payment is over the limit', async () => {
    mockSignPayment.mockRejectedValue(new X402PaymentLimitError('x402 payment refused: $1.00'));
    const baseFetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    const fetchFn = createX402FetchMiddleware(baseFetch as never, {
      wallet: WALLET,
      getToolByName: () => makePaidTool({ accepts: [EXACT_ACCEPT] }),
      paymentCache: { signature: null },
      maxAmountAtomicUnits: 500_000n,
    });

    await expect(
      fetchFn('https://example.test/mcp', { method: 'POST', body: toolsCallBody('paid-tool') })
    ).rejects.toThrow('x402 payment refused');
    expect(baseFetch).not.toHaveBeenCalled();
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

  it('passes the spend limit to the signer', async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('', { status: 402, headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader } })
      )
      .mockResolvedValue(new Response('', { status: 200 }));
    const fetchFn = createX402FetchMiddleware(baseFetch as never, {
      wallet: WALLET,
      getToolByName: () => undefined,
      paymentCache: { signature: null },
      maxAmountAtomicUnits: 500_000n,
    });

    await fetchFn('https://example.test/mcp', { method: 'POST', body: toolsCallBody('paid-tool') });

    expect(mockSignPayment.mock.calls[0]?.[0]?.maxAmountAtomicUnits).toBe(500_000n);
  });

  it('lets a call-scoped limit replace the session limit, in either direction', async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValue(
        new Response('', { status: 402, headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader } })
      );
    const fetchFn = createX402FetchMiddleware(baseFetch as never, {
      wallet: WALLET,
      getToolByName: () => undefined,
      paymentCache: { signature: null },
      maxAmountAtomicUnits: 500_000n,
    });
    const call = (): Promise<unknown> =>
      fetchFn('https://example.test/mcp', { method: 'POST', body: toolsCallBody('paid-tool') });

    // Raising: the session caps at $0.50, this call allows $2.00
    await runWithPaymentLimit(2_000_000n, call);
    expect(mockSignPayment.mock.calls[0]?.[0]).toMatchObject({
      maxAmountAtomicUnits: 2_000_000n,
      maxAmountScope: 'call',
    });

    // Lowering: this call allows $0.10
    await runWithPaymentLimit(100_000n, call);
    expect(mockSignPayment.mock.calls[1]?.[0]).toMatchObject({
      maxAmountAtomicUnits: 100_000n,
      maxAmountScope: 'call',
    });

    // Unscoped: back to the session limit
    await call();
    expect(mockSignPayment.mock.calls[2]?.[0]).toMatchObject({
      maxAmountAtomicUnits: 500_000n,
      maxAmountScope: 'session',
    });
  });

  it('caps a call even when the session set no limit', async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValue(
        new Response('', { status: 402, headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader } })
      );
    const fetchFn = createX402FetchMiddleware(baseFetch as never, {
      wallet: WALLET,
      getToolByName: () => undefined,
      paymentCache: { signature: null },
    });

    await runWithPaymentLimit(100_000n, () =>
      fetchFn('https://example.test/mcp', { method: 'POST', body: toolsCallBody('paid-tool') })
    );

    expect(mockSignPayment.mock.calls[0]?.[0]).toMatchObject({
      maxAmountAtomicUnits: 100_000n,
      maxAmountScope: 'call',
    });
  });

  it('keeps concurrent calls on their own limits', async () => {
    // The regression a shared field would cause: the second call's limit overwriting the
    // first's while the first is still waiting for its 402. Each middleware challenges for
    // a different asset, so the signer calls can be told apart.
    const challengeFor = (asset: string): string =>
      Buffer.from(
        JSON.stringify({ x402Version: 2, accepts: [{ ...EXACT_ACCEPT, asset }] })
      ).toString('base64');

    const makeBlockingFetch = (
      asset: string
    ): { fetch: ReturnType<typeof vi.fn>; open: () => void } => {
      let release: () => void = () => {};
      const fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        // The retry (which carries the signature) must not block, or the call never ends
        if (new Headers(init?.headers).get('PAYMENT-SIGNATURE')) {
          return Promise.resolve(new Response('', { status: 200 }));
        }
        return new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              new Response('', {
                status: 402,
                headers: { 'PAYMENT-REQUIRED': challengeFor(asset) },
              })
            );
        });
      });
      return { fetch, open: () => release() };
    };

    const cheap = makeBlockingFetch('0xCheapAsset');
    const pricey = makeBlockingFetch('0xPriceyAsset');
    const middlewareFor = (
      baseFetch: ReturnType<typeof vi.fn>
    ): ReturnType<typeof createX402FetchMiddleware> =>
      createX402FetchMiddleware(baseFetch as never, {
        wallet: WALLET,
        getToolByName: () => undefined,
        paymentCache: { signature: null },
      });
    const call = (baseFetch: ReturnType<typeof vi.fn>): Promise<unknown> =>
      middlewareFor(baseFetch)('https://example.test/mcp', {
        method: 'POST',
        body: toolsCallBody('paid-tool'),
      });

    // Both calls are in flight, each inside its own limit, before either 402 arrives
    const cheapCall = runWithPaymentLimit(100_000n, () => call(cheap.fetch));
    const priceyCall = runWithPaymentLimit(5_000_000n, () => call(pricey.fetch));
    await vi.waitFor(() => {
      expect(cheap.fetch).toHaveBeenCalled();
      expect(pricey.fetch).toHaveBeenCalled();
    });
    pricey.open();
    cheap.open();
    await Promise.all([cheapCall, priceyCall]);

    const limitForAsset = (asset: string): unknown =>
      mockSignPayment.mock.calls.find((c) => c[0]?.accept?.asset === asset)?.[0]
        ?.maxAmountAtomicUnits;
    expect(limitForAsset('0xCheapAsset')).toBe(100_000n);
    expect(limitForAsset('0xPriceyAsset')).toBe(5_000_000n);
  });

  it('surfaces a refused payment instead of returning the 402 to the caller', async () => {
    mockSignPayment.mockRejectedValue(new X402PaymentLimitError('x402 payment refused: $1.00'));
    const baseFetch = vi
      .fn()
      .mockResolvedValue(
        new Response('', { status: 402, headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader } })
      );
    const fetchFn = createX402FetchMiddleware(baseFetch as never, {
      wallet: WALLET,
      getToolByName: () => undefined,
      paymentCache: { signature: null },
      maxAmountAtomicUnits: 500_000n,
    });

    await expect(
      fetchFn('https://example.test/mcp', { method: 'POST', body: toolsCallBody('paid-tool') })
    ).rejects.toThrow('x402 payment refused');
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

// ---------------------------------------------------------------------------
// settlement receipts — PAYMENT-RESPONSE header → _meta["x402/payment-response"]
// ---------------------------------------------------------------------------

describe('settlement receipts (PAYMENT-RESPONSE)', () => {
  const paymentRequiredHeader = Buffer.from(
    JSON.stringify({ x402Version: 2, accepts: [EXACT_ACCEPT] })
  ).toString('base64');

  const RECEIPT = {
    success: true,
    transaction: '0xdeadbeef',
    network: 'eip155:8453',
    payer: WALLET.address,
  };

  function paymentResponseHeader(receipt: unknown): string {
    return Buffer.from(JSON.stringify(receipt)).toString('base64');
  }

  function paidResponse(receipt: unknown): Response {
    return new Response('', {
      status: 200,
      headers: { 'PAYMENT-RESPONSE': paymentResponseHeader(receipt) },
    });
  }

  it('captures the receipt from the retry after a 402 and attaches it to the tool result', async () => {
    const cache: X402PaymentCache = { signature: null };
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('', { status: 402, headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader } })
      )
      .mockResolvedValueOnce(paidResponse(RECEIPT));
    const fetchFn = createX402FetchMiddleware(baseFetch as never, {
      wallet: WALLET,
      getToolByName: () => undefined,
      paymentCache: cache,
    });

    await fetchFn('https://example.test/mcp', { method: 'POST', body: toolsCallBody('paid-tool') });

    const result = withSettlementReceipt({ content: [] }, cache, 'paid-tool');
    expect(result).toEqual({
      content: [],
      _meta: { 'x402/payment-response': RECEIPT },
    });
  });

  it('captures the receipt on a proactively signed call', async () => {
    const cache: X402PaymentCache = { signature: null };
    const baseFetch = vi.fn().mockResolvedValue(paidResponse(RECEIPT));
    const fetchFn = createX402FetchMiddleware(baseFetch as never, {
      wallet: WALLET,
      getToolByName: () => makePaidTool({ accepts: [EXACT_ACCEPT] }),
      paymentCache: cache,
    });

    await fetchFn('https://example.test/mcp', { method: 'POST', body: toolsCallBody('paid-tool') });

    expect(cache.lastSettlement).toEqual({ toolName: 'paid-tool', receipt: RECEIPT });
  });

  it('consumes the receipt once, so a later unpaid call does not claim it', () => {
    const cache: X402PaymentCache = {
      signature: null,
      lastSettlement: { toolName: 'paid-tool', receipt: RECEIPT },
    };

    expect(withSettlementReceipt({ content: [] }, cache, 'paid-tool')).toHaveProperty('_meta', {
      'x402/payment-response': RECEIPT,
    });
    expect(withSettlementReceipt({ content: [] }, cache, 'paid-tool')).toEqual({ content: [] });
  });

  it('keeps a receipt the server reported over the MCP channel', () => {
    const serverReceipt = { success: true, transaction: '0xserver', network: 'eip155:8453' };
    const cache: X402PaymentCache = {
      signature: null,
      lastSettlement: { toolName: 'paid-tool', receipt: RECEIPT },
    };

    const result = withSettlementReceipt(
      { content: [], _meta: { 'x402/payment-response': serverReceipt } },
      cache,
      'paid-tool'
    );

    expect(result._meta['x402/payment-response']).toBe(serverReceipt);
    // Still consumed, so it cannot resurface on the next call to the same tool
    expect(cache.lastSettlement).toBeUndefined();
  });

  it('preserves other _meta keys on the tool result', () => {
    const cache: X402PaymentCache = {
      signature: null,
      lastSettlement: { toolName: 'paid-tool', receipt: RECEIPT },
    };

    const result = withSettlementReceipt(
      { content: [], _meta: { trace: 'abc' } },
      cache,
      'paid-tool'
    );

    expect(result._meta).toEqual({ trace: 'abc', 'x402/payment-response': RECEIPT });
  });

  it.each([
    ['not base64-encoded JSON', 'not-base64-json!!'],
    ['a JSON array', Buffer.from('[1,2,3]').toString('base64')],
    ['a JSON scalar', Buffer.from('"paid"').toString('base64')],
  ])(
    'fails open when the server sends %s, leaving the result untouched',
    async (_label, header) => {
      const cache: X402PaymentCache = { signature: null };
      const baseFetch = vi
        .fn()
        .mockResolvedValue(
          new Response('', { status: 200, headers: { 'PAYMENT-RESPONSE': header } })
        );
      const fetchFn = createX402FetchMiddleware(baseFetch as never, {
        wallet: WALLET,
        getToolByName: () => makePaidTool({ accepts: [EXACT_ACCEPT] }),
        paymentCache: cache,
      });

      const response = await fetchFn('https://example.test/mcp', {
        method: 'POST',
        body: toolsCallBody('paid-tool'),
      });

      expect(response.status).toBe(200);
      expect(cache.lastSettlement).toBeUndefined();
      expect(withSettlementReceipt({ content: [] }, cache, 'paid-tool')).toEqual({ content: [] });
    }
  );

  it('records nothing when the server omits the header', async () => {
    const cache: X402PaymentCache = { signature: null };
    const baseFetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    const fetchFn = createX402FetchMiddleware(baseFetch as never, {
      wallet: WALLET,
      getToolByName: () => makePaidTool({ accepts: [EXACT_ACCEPT] }),
      paymentCache: cache,
    });

    await fetchFn('https://example.test/mcp', { method: 'POST', body: toolsCallBody('paid-tool') });

    expect(cache.lastSettlement).toBeUndefined();
  });

  it('drops an oversized receipt instead of attaching it to every tool result', async () => {
    const cache: X402PaymentCache = { signature: null };
    const huge = Buffer.from(JSON.stringify({ success: true, pad: 'x'.repeat(100_000) })).toString(
      'base64'
    );
    const baseFetch = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 200, headers: { 'PAYMENT-RESPONSE': huge } }));
    const fetchFn = createX402FetchMiddleware(baseFetch as never, {
      wallet: WALLET,
      getToolByName: () => makePaidTool({ accepts: [EXACT_ACCEPT] }),
      paymentCache: cache,
    });

    await fetchFn('https://example.test/mcp', { method: 'POST', body: toolsCallBody('paid-tool') });

    expect(cache.lastSettlement).toBeUndefined();
  });
});
