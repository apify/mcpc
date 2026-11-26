/**
 * Unit tests for x402 signer (exact + upto schemes)
 */

import { ClientError } from '../../../../src/lib/errors.js';
import { PaymentRefusedError } from '../../../../src/lib/x402/limits.js';
import {
  approvePermit2,
  MAX_PAYMENT_EXPIRY_SECONDS,
  parsePaymentRequired,
  selectAcceptEntry,
  signPayment,
  X402_VERSION,
  type PaymentRequiredAccept,
  type SignerWallet,
} from '../../../../src/lib/x402/signer.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const MOCK_SIGNATURE = '0xdeadbeef1234567890';
const MOCK_ADDRESS = '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B';
const MOCK_APPROVE_TX_HASH = '0xabcdef1234567890';

// `vi.mock` is hoisted above local `const` declarations, so the mock fns used
// inside the factory must come from `vi.hoisted`. Same pattern as grep.test.ts.
const { mockReadContract, mockSendTransaction, mockWaitForTransactionReceipt, mockSignTypedData } =
  vi.hoisted(() => ({
    mockReadContract: vi.fn(),
    mockSendTransaction: vi.fn(),
    mockWaitForTransactionReceipt: vi.fn(),
    mockSignTypedData: vi.fn(),
  }));

// Mock the viem boundary module (the only file importing viem). The spread of
// the original keeps real values for everything not stubbed — notably the
// `base`/`baseSepolia` chain objects, of which only `.id` is used.
vi.mock('../../../../src/lib/x402/viem.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../src/lib/x402/viem.js')>();
  return {
    ...original,
    createPublicClient: vi.fn().mockReturnValue({
      readContract: (...args: unknown[]) => mockReadContract(...args),
      waitForTransactionReceipt: (...args: unknown[]) => mockWaitForTransactionReceipt(...args),
    }),
    createWalletClient: vi.fn().mockReturnValue({
      signTypedData: (...args: unknown[]) => mockSignTypedData(...args),
      sendTransaction: (...args: unknown[]) => mockSendTransaction(...args),
    }),
    encodeFunctionData: vi.fn().mockReturnValue('0xencodedapprovedata'),
    getAddress: vi.fn((addr: string) => addr.toLowerCase()),
    http: vi.fn().mockReturnValue('http-transport'),
    privateKeyToAccount: vi.fn().mockReturnValue({
      address: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B',
    }),
  };
});

// Default mock behaviour — allowance is sufficient, no approve needed, signing succeeds.
beforeEach(() => {
  mockReadContract.mockReset();
  mockSendTransaction.mockReset();
  mockWaitForTransactionReceipt.mockReset();
  mockSignTypedData.mockReset();
  mockReadContract.mockResolvedValue(BigInt('1000000000000000000000000')); // huge allowance
  mockSendTransaction.mockResolvedValue(MOCK_APPROVE_TX_HASH);
  mockWaitForTransactionReceipt.mockResolvedValue({ status: 'success', blockNumber: 1n });
  mockSignTypedData.mockResolvedValue(MOCK_SIGNATURE);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_EXACT_ACCEPT: PaymentRequiredAccept = {
  scheme: 'exact',
  network: 'eip155:84532',
  amount: '1000000',
  asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  payTo: '0xdf278412ecbe00d6381408f739eb8da60542a0c4',
  maxTimeoutSeconds: 60,
  extra: { name: 'USDC', version: '2' },
};

const VALID_UPTO_ACCEPT: PaymentRequiredAccept = {
  scheme: 'upto',
  network: 'eip155:84532',
  amount: '5000000',
  asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  payTo: '0xdf278412ecbe00d6381408f739eb8da60542a0c4',
  maxTimeoutSeconds: 3600,
  extra: {
    name: 'USDC',
    version: '2',
    facilitatorAddress: '0x4020a4f3b7b90cca423b9fabcc0ce57c6c240002',
  },
};

// Apify's x402 endpoints offer the same price on Base and on Solana; mcpc signs EVM only.
const SOLANA_EXACT_ACCEPT: PaymentRequiredAccept = {
  scheme: 'exact',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  amount: '1000000',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: 'ECUPkq6DP8VUSEueL4qNznyNDJLwu6PQhnMQ5cuZsTLH',
  maxTimeoutSeconds: 60,
};

const MOCK_WALLET: SignerWallet = {
  privateKey: '0x1234567890abcdef',
  address: MOCK_ADDRESS,
};

function buildPaymentRequired(accepts: PaymentRequiredAccept[]): string {
  const header = {
    x402Version: 2,
    resource: {
      url: 'https://mcp.apify.com/mcp',
      description: 'MCP Server',
      mimeType: 'application/json',
    },
    accepts,
  };
  return Buffer.from(JSON.stringify(header)).toString('base64');
}

// ---------------------------------------------------------------------------
// selectAcceptEntry
// ---------------------------------------------------------------------------

describe('selectAcceptEntry', () => {
  it('auto: prefers upto over exact', () => {
    const result = selectAcceptEntry([VALID_EXACT_ACCEPT, VALID_UPTO_ACCEPT], 'auto');
    expect(result?.scheme).toBe('upto');
  });

  it('auto: falls back to exact when upto is invalid', () => {
    const invalidUpto = { ...VALID_UPTO_ACCEPT, extra: { name: 'USDC' } }; // missing facilitatorAddress
    const result = selectAcceptEntry([VALID_EXACT_ACCEPT, invalidUpto], 'auto');
    expect(result?.scheme).toBe('exact');
  });

  it('auto: returns undefined when nothing valid', () => {
    const result = selectAcceptEntry([], 'auto');
    expect(result).toBeUndefined();
  });

  it('upto: returns upto when valid', () => {
    const result = selectAcceptEntry([VALID_EXACT_ACCEPT, VALID_UPTO_ACCEPT], 'upto');
    expect(result?.scheme).toBe('upto');
  });

  it('upto: returns undefined when upto invalid', () => {
    const invalidUpto = { ...VALID_UPTO_ACCEPT, extra: {} };
    const result = selectAcceptEntry([VALID_EXACT_ACCEPT, invalidUpto], 'upto');
    expect(result).toBeUndefined();
  });

  it('exact: returns exact when valid', () => {
    const result = selectAcceptEntry([VALID_UPTO_ACCEPT, VALID_EXACT_ACCEPT], 'exact');
    expect(result?.scheme).toBe('exact');
  });

  it('exact: returns undefined when exact invalid', () => {
    const invalidExact = { ...VALID_EXACT_ACCEPT, payTo: '' };
    const result = selectAcceptEntry([invalidExact, VALID_UPTO_ACCEPT], 'exact');
    expect(result).toBeUndefined();
  });

  it('auto: prefers first valid upto', () => {
    const secondUpto = { ...VALID_UPTO_ACCEPT, amount: '9999999' };
    const result = selectAcceptEntry([VALID_EXACT_ACCEPT, VALID_UPTO_ACCEPT, secondUpto], 'auto');
    expect(result?.amount).toBe('5000000');
  });

  it('auto: prefers first valid exact when no upto', () => {
    const secondExact = { ...VALID_EXACT_ACCEPT, amount: '9999999' };
    const result = selectAcceptEntry([VALID_EXACT_ACCEPT, secondExact], 'auto');
    expect(result?.amount).toBe('1000000');
  });

  it('exact: skips entries on unsupported networks', () => {
    const result = selectAcceptEntry([SOLANA_EXACT_ACCEPT, VALID_EXACT_ACCEPT], 'exact');
    expect(result?.network).toBe('eip155:84532');
  });

  it('upto: skips entries on unsupported networks', () => {
    const solanaUpto = { ...VALID_UPTO_ACCEPT, network: SOLANA_EXACT_ACCEPT.network };
    const result = selectAcceptEntry([solanaUpto, VALID_UPTO_ACCEPT], 'upto');
    expect(result?.network).toBe('eip155:84532');
  });

  it('auto: prefers a supported exact over an upto on an unsupported network', () => {
    const solanaUpto = { ...VALID_UPTO_ACCEPT, network: SOLANA_EXACT_ACCEPT.network };
    const result = selectAcceptEntry([solanaUpto, VALID_EXACT_ACCEPT], 'auto');
    expect(result?.scheme).toBe('exact');
  });

  it('returns undefined when every entry is on an unsupported network', () => {
    const result = selectAcceptEntry([SOLANA_EXACT_ACCEPT], 'auto');
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parsePaymentRequired
// ---------------------------------------------------------------------------

describe('parsePaymentRequired', () => {
  it('parses exact-only header with auto', () => {
    const b64 = buildPaymentRequired([VALID_EXACT_ACCEPT]);
    const { header, accept } = parsePaymentRequired(b64, 'auto');
    expect(header.x402Version).toBe(2);
    expect(accept.scheme).toBe('exact');
  });

  it('parses upto-only header with auto', () => {
    const b64 = buildPaymentRequired([VALID_UPTO_ACCEPT]);
    const { header, accept } = parsePaymentRequired(b64, 'auto');
    expect(accept.scheme).toBe('upto');
  });

  it('mixed header: auto selects upto', () => {
    const b64 = buildPaymentRequired([VALID_EXACT_ACCEPT, VALID_UPTO_ACCEPT]);
    const { accept } = parsePaymentRequired(b64, 'auto');
    expect(accept.scheme).toBe('upto');
  });

  it('mixed header: force exact', () => {
    const b64 = buildPaymentRequired([VALID_UPTO_ACCEPT, VALID_EXACT_ACCEPT]);
    const { accept } = parsePaymentRequired(b64, 'exact');
    expect(accept.scheme).toBe('exact');
  });

  it('mixed header: force upto', () => {
    const b64 = buildPaymentRequired([VALID_EXACT_ACCEPT, VALID_UPTO_ACCEPT]);
    const { accept } = parsePaymentRequired(b64, 'upto');
    expect(accept.scheme).toBe('upto');
  });

  it('throws on invalid JSON after base64 decode', () => {
    const b64 = Buffer.from('not-json').toString('base64');
    expect(() => parsePaymentRequired(b64)).toThrow(ClientError);
    expect(() => parsePaymentRequired(b64)).toThrow('not valid JSON');
  });

  it('throws on empty accepts', () => {
    const b64 = buildPaymentRequired([]);
    expect(() => parsePaymentRequired(b64)).toThrow(ClientError);
    expect(() => parsePaymentRequired(b64)).toThrow('no "accepts" entries');
  });

  it('throws when no matching scheme (auto)', () => {
    const b64 = buildPaymentRequired([{ ...VALID_EXACT_ACCEPT, scheme: 'unknown' }]);
    expect(() => parsePaymentRequired(b64, 'auto')).toThrow(ClientError);
    expect(() => parsePaymentRequired(b64, 'auto')).toThrow('exact or upto');
  });

  it('throws when forced scheme unavailable', () => {
    const b64 = buildPaymentRequired([VALID_EXACT_ACCEPT]);
    expect(() => parsePaymentRequired(b64, 'upto')).toThrow(ClientError);
    expect(() => parsePaymentRequired(b64, 'upto')).toThrow('upto');
  });

  it('picks the Base entry when a Solana entry is listed first', () => {
    const b64 = buildPaymentRequired([SOLANA_EXACT_ACCEPT, VALID_EXACT_ACCEPT]);
    const { accept } = parsePaymentRequired(b64, 'auto');
    expect(accept.network).toBe('eip155:84532');
  });

  it('throws naming the offered and the supported networks when none is supported', () => {
    const b64 = buildPaymentRequired([SOLANA_EXACT_ACCEPT]);
    expect(() => parsePaymentRequired(b64, 'exact')).toThrow(ClientError);
    expect(() => parsePaymentRequired(b64, 'exact')).toThrow(
      'exact on solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
    );
    expect(() => parsePaymentRequired(b64, 'exact')).toThrow('Supported networks: eip155:8453');
  });
});

// ---------------------------------------------------------------------------
// signPayment
// ---------------------------------------------------------------------------

describe('signPayment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exact scheme: produces correct payload shape', async () => {
    const result = await signPayment({ wallet: MOCK_WALLET, accept: VALID_EXACT_ACCEPT });

    expect(result.from).toBe(MOCK_ADDRESS);
    expect(result.to).toBe(VALID_EXACT_ACCEPT.payTo);
    expect(result.networkLabel).toBe('Base Sepolia (testnet)');

    const payload = JSON.parse(
      Buffer.from(result.paymentSignatureBase64, 'base64').toString('utf-8')
    );
    expect(payload.x402Version).toBe(X402_VERSION);
    expect(payload.accepted.scheme).toBe('exact');
    expect(payload.payload.authorization).toBeDefined();
    expect(payload.payload.authorization.from).toBe(MOCK_ADDRESS);
    expect(payload.payload.authorization.to).toBe(VALID_EXACT_ACCEPT.payTo);
    expect(payload.payload.authorization.value).toBe(VALID_EXACT_ACCEPT.amount);
    expect(payload.payload.permit2Authorization).toBeUndefined();
  });

  it('upto scheme: produces correct payload shape with permit2Authorization', async () => {
    const result = await signPayment({ wallet: MOCK_WALLET, accept: VALID_UPTO_ACCEPT });

    expect(result.from).toBe(MOCK_ADDRESS);
    expect(result.to).toBe(VALID_UPTO_ACCEPT.payTo);
    expect(result.networkLabel).toBe('Base Sepolia (testnet)');

    const payload = JSON.parse(
      Buffer.from(result.paymentSignatureBase64, 'base64').toString('utf-8')
    );
    expect(payload.x402Version).toBe(X402_VERSION);
    expect(payload.accepted.scheme).toBe('upto');
    expect(payload.payload.permit2Authorization).toBeDefined();
    expect(payload.payload.authorization).toBeUndefined();

    const permit2 = payload.payload.permit2Authorization;
    expect(permit2.from).toBe(MOCK_ADDRESS);
    expect(permit2.spender).toBe('0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002');
    expect(permit2.permitted.token).toBe(VALID_UPTO_ACCEPT.asset.toLowerCase());
    expect(permit2.permitted.amount).toBe(VALID_UPTO_ACCEPT.amount);
    expect(permit2.witness.to).toBe(VALID_UPTO_ACCEPT.payTo.toLowerCase());
    expect(permit2.witness.facilitator).toBe(
      VALID_UPTO_ACCEPT.extra!.facilitatorAddress!.toLowerCase()
    );

    // accepted should include facilitatorAddress
    expect(payload.accepted.extra.facilitatorAddress).toBe(
      VALID_UPTO_ACCEPT.extra!.facilitatorAddress
    );
  });

  it('upto scheme: throws when facilitatorAddress missing', async () => {
    const invalidUpto = { ...VALID_UPTO_ACCEPT, extra: { name: 'USDC', version: '2' } };
    await expect(signPayment({ wallet: MOCK_WALLET, accept: invalidUpto })).rejects.toThrow(
      ClientError
    );
    await expect(signPayment({ wallet: MOCK_WALLET, accept: invalidUpto })).rejects.toThrow(
      'facilitatorAddress'
    );
  });

  it('exact scheme: uses amountOverride', async () => {
    const result = await signPayment({
      wallet: MOCK_WALLET,
      accept: VALID_EXACT_ACCEPT,
      amountOverride: 2000000n,
    });
    const payload = JSON.parse(
      Buffer.from(result.paymentSignatureBase64, 'base64').toString('utf-8')
    );
    expect(payload.accepted.amount).toBe('2000000');
    expect(payload.payload.authorization.value).toBe('2000000');
    expect(result.amountUsd).toBe(2);
  });

  it('upto scheme: uses amountOverride as max cap', async () => {
    const result = await signPayment({
      wallet: MOCK_WALLET,
      accept: VALID_UPTO_ACCEPT,
      amountOverride: 3000000n,
    });
    const payload = JSON.parse(
      Buffer.from(result.paymentSignatureBase64, 'base64').toString('utf-8')
    );
    expect(payload.accepted.amount).toBe('3000000');
    expect(payload.payload.permit2Authorization.permitted.amount).toBe('3000000');
    expect(result.amountUsd).toBe(3);
  });

  it('unsupported scheme: throws', async () => {
    const invalid = { ...VALID_EXACT_ACCEPT, scheme: 'unknown' };
    await expect(signPayment({ wallet: MOCK_WALLET, accept: invalid })).rejects.toThrow(
      'Unsupported x402 scheme: unknown'
    );
  });

  it('unknown network: throws', async () => {
    const invalid = { ...VALID_EXACT_ACCEPT, network: 'eip155:99999' };
    await expect(signPayment({ wallet: MOCK_WALLET, accept: invalid })).rejects.toThrow(
      'Unknown network'
    );
  });

  // -------------------------------------------------------------------------
  // Server-controlled terms: token, amount, expiry
  // -------------------------------------------------------------------------

  describe('server-controlled terms', () => {
    const OTHER_TOKEN = '0x4200000000000000000000000000000000000006'; // WETH on Base

    it.each(['exact', 'upto'])('%s: refuses a token other than USDC', async (scheme) => {
      const accept = scheme === 'exact' ? VALID_EXACT_ACCEPT : VALID_UPTO_ACCEPT;
      await expect(
        signPayment({ wallet: MOCK_WALLET, accept: { ...accept, asset: OTHER_TOKEN } })
      ).rejects.toThrow(PaymentRefusedError);
      expect(mockSignTypedData).not.toHaveBeenCalled();
      expect(mockReadContract).not.toHaveBeenCalled();
      expect(mockSendTransaction).not.toHaveBeenCalled();
    });

    it('refuses the USDC address of another network', async () => {
      const mainnetUsdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
      await expect(
        signPayment({ wallet: MOCK_WALLET, accept: { ...VALID_EXACT_ACCEPT, asset: mainnetUsdc } })
      ).rejects.toThrow(/only pays in USDC/);
    });

    it('selectAcceptEntry skips entries in another token', () => {
      const other = { ...VALID_EXACT_ACCEPT, asset: OTHER_TOKEN };
      expect(selectAcceptEntry([other, VALID_EXACT_ACCEPT], 'exact')).toBe(VALID_EXACT_ACCEPT);
      expect(selectAcceptEntry([other], 'auto')).toBeUndefined();
    });

    it.each(['1.5', '-1', '0x10', '', 'abc'])('refuses the amount %j', async (amount) => {
      await expect(
        signPayment({ wallet: MOCK_WALLET, accept: { ...VALID_EXACT_ACCEPT, amount } })
      ).rejects.toThrow(/invalid amount|Unsupported|missing/);
      expect(mockSignTypedData).not.toHaveBeenCalled();
    });

    it.each(['exact', 'upto'])(
      '%s: clamps a server-chosen validity to one hour',
      async (scheme) => {
        const accept = scheme === 'exact' ? VALID_EXACT_ACCEPT : VALID_UPTO_ACCEPT;
        const tenYearsSecs = 10 * 365 * 24 * 3600;
        const before = Date.now();
        const result = await signPayment({
          wallet: MOCK_WALLET,
          accept: { ...accept, maxTimeoutSeconds: tenYearsSecs },
        });

        expect(result.expiresAt.getTime()).toBeLessThanOrEqual(
          Date.now() + MAX_PAYMENT_EXPIRY_SECONDS * 1000
        );
        expect(result.expiresAt.getTime()).toBeGreaterThan(before + 3590 * 1000);
        const payload = JSON.parse(Buffer.from(result.paymentSignatureBase64, 'base64').toString());
        expect(payload.accepted.maxTimeoutSeconds).toBe(MAX_PAYMENT_EXPIRY_SECONDS);
      }
    );

    it.each([Number.NaN, -5, 0, '600' as unknown as number, undefined as unknown as number])(
      'falls back to the default validity for maxTimeoutSeconds=%j',
      async (maxTimeoutSeconds) => {
        const result = await signPayment({
          wallet: MOCK_WALLET,
          accept: { ...VALID_EXACT_ACCEPT, maxTimeoutSeconds },
        });
        const secs = (result.expiresAt.getTime() - Date.now()) / 1000;
        expect(secs).toBeGreaterThan(3590);
        expect(secs).toBeLessThanOrEqual(3600);
      }
    );

    it("keeps the caller's own expiry override, even past the clamp", async () => {
      const result = await signPayment({
        wallet: MOCK_WALLET,
        accept: VALID_EXACT_ACCEPT,
        expiryOverrideSecs: 7200,
      });
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now() + 7190 * 1000);
    });

    it('exact scheme: the authorization is not valid from the beginning of time', async () => {
      const result = await signPayment({ wallet: MOCK_WALLET, accept: VALID_EXACT_ACCEPT });
      const payload = JSON.parse(Buffer.from(result.paymentSignatureBase64, 'base64').toString());
      const validAfter = Number(payload.payload.authorization.validAfter);
      const nowSecs = Date.now() / 1000;
      expect(validAfter).toBeGreaterThan(nowSecs - 700);
      expect(validAfter).toBeLessThan(nowSecs);
      const message = mockSignTypedData.mock.calls[0]?.[0]?.message as { validAfter: bigint };
      expect(message.validAfter).toBe(BigInt(validAfter));
    });
  });

  // -------------------------------------------------------------------------
  // upto scheme — Permit2 allowance is checked, never granted, when signing
  // -------------------------------------------------------------------------

  describe('upto: Permit2 allowance', () => {
    it('signs when the existing allowance covers the amount', async () => {
      // VALID_UPTO_ACCEPT.amount is "5000000" — return exactly that.
      mockReadContract.mockResolvedValueOnce(BigInt('5000000'));

      await signPayment({ wallet: MOCK_WALLET, accept: VALID_UPTO_ACCEPT });

      expect(mockReadContract).toHaveBeenCalledTimes(1);
      expect(mockSendTransaction).not.toHaveBeenCalled();
      expect(mockWaitForTransactionReceipt).not.toHaveBeenCalled();
    });

    it('refuses, without sending any transaction, when the allowance is short', async () => {
      mockReadContract.mockResolvedValueOnce(0n);

      const signing = signPayment({ wallet: MOCK_WALLET, accept: VALID_UPTO_ACCEPT });

      await expect(signing).rejects.toThrow(PaymentRefusedError);
      await expect(signing).rejects.toThrow('mcpc x402 approve --network base-sepolia');
      expect(mockSendTransaction).not.toHaveBeenCalled();
      expect(mockSignTypedData).not.toHaveBeenCalled();
    });

    it('skipPermit2Check bypasses the allowance read entirely', async () => {
      mockReadContract.mockResolvedValueOnce(0n);

      await signPayment({
        wallet: MOCK_WALLET,
        accept: VALID_UPTO_ACCEPT,
        skipPermit2Check: true,
      });

      expect(mockReadContract).not.toHaveBeenCalled();
      expect(mockSendTransaction).not.toHaveBeenCalled();
    });

    it('exact scheme does not perform allowance check', async () => {
      await signPayment({ wallet: MOCK_WALLET, accept: VALID_EXACT_ACCEPT });

      expect(mockReadContract).not.toHaveBeenCalled();
      expect(mockSendTransaction).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// approvePermit2 — the explicit `mcpc x402 approve` step
// ---------------------------------------------------------------------------

describe('approvePermit2', () => {
  const SEPOLIA_USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
  const MAX_UINT256 = 2n ** 256n - 1n;

  it('approves Permit2 for the network USDC and reports the transaction', async () => {
    mockReadContract.mockResolvedValueOnce(0n).mockResolvedValueOnce(MAX_UINT256);

    const result = await approvePermit2({ wallet: MOCK_WALLET, network: 'base-sepolia' });

    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    const sendArgs = mockSendTransaction.mock.calls[0]?.[0] as { to: string; data: string };
    expect(sendArgs.to).toBe(SEPOLIA_USDC);
    expect(sendArgs.data).toBe('0xencodedapprovedata');
    expect(mockWaitForTransactionReceipt).toHaveBeenCalledWith({ hash: MOCK_APPROVE_TX_HASH });
    expect(result).toMatchObject({
      network: 'eip155:84532',
      token: SEPOLIA_USDC,
      previousAllowance: 0n,
      allowance: MAX_UINT256,
      transaction: MOCK_APPROVE_TX_HASH,
    });
  });

  it('defaults to nothing but the mainnet USDC contract', async () => {
    mockReadContract.mockResolvedValueOnce(0n).mockResolvedValueOnce(MAX_UINT256);

    await approvePermit2({ wallet: MOCK_WALLET, network: 'base' });

    const sendArgs = mockSendTransaction.mock.calls[0]?.[0] as { to: string };
    expect(sendArgs.to).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  });

  it('sends nothing when the allowance is already unlimited', async () => {
    mockReadContract.mockResolvedValueOnce(MAX_UINT256);

    const result = await approvePermit2({ wallet: MOCK_WALLET, network: 'eip155:84532' });

    expect(mockSendTransaction).not.toHaveBeenCalled();
    expect(result.transaction).toBeUndefined();
    expect(result.allowance).toBe(MAX_UINT256);
  });

  it('sets a bounded allowance, and 0 revokes', async () => {
    mockReadContract.mockResolvedValueOnce(MAX_UINT256).mockResolvedValueOnce(0n);

    const result = await approvePermit2({
      wallet: MOCK_WALLET,
      network: 'base-sepolia',
      allowance: 0n,
    });

    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    expect(result.allowance).toBe(0n);
  });

  it('throws when the approve transaction reverts on-chain', async () => {
    mockReadContract.mockResolvedValueOnce(0n);
    mockWaitForTransactionReceipt.mockResolvedValueOnce({ status: 'reverted', blockNumber: 1n });

    await expect(approvePermit2({ wallet: MOCK_WALLET, network: 'base-sepolia' })).rejects.toThrow(
      'reverted on-chain'
    );
  });

  it('rejects an unknown network', async () => {
    await expect(approvePermit2({ wallet: MOCK_WALLET, network: 'solana' })).rejects.toThrow(
      'Unknown network "solana". Supported: base, base-sepolia'
    );
  });
});
