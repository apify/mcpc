/**
 * Unit tests for x402 signer (exact + upto schemes)
 */

import { ClientError } from '../../../../src/lib/errors.js';
import {
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

vi.mock('viem', () => ({
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
}));

vi.mock('viem/accounts', () => ({
  privateKeyToAccount: vi.fn().mockReturnValue({
    address: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B',
  }),
}));

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
  // upto scheme — Permit2 allowance auto-approval
  // -------------------------------------------------------------------------

  describe('upto: Permit2 allowance auto-approval', () => {
    it('skips approval when existing allowance >= required amount', async () => {
      // VALID_UPTO_ACCEPT.amount is "5000000" — return exactly that.
      mockReadContract.mockResolvedValueOnce(BigInt('5000000'));

      await signPayment({ wallet: MOCK_WALLET, accept: VALID_UPTO_ACCEPT });

      expect(mockReadContract).toHaveBeenCalledTimes(1);
      expect(mockSendTransaction).not.toHaveBeenCalled();
      expect(mockWaitForTransactionReceipt).not.toHaveBeenCalled();
    });

    it('sends approve(MAX_UINT256) when allowance is short, then signs', async () => {
      // First read: insufficient. Second read after approve: max.
      mockReadContract
        .mockResolvedValueOnce(0n)
        .mockResolvedValueOnce(BigInt('1000000000000000000000000'));

      const result = await signPayment({ wallet: MOCK_WALLET, accept: VALID_UPTO_ACCEPT });

      expect(mockSendTransaction).toHaveBeenCalledTimes(1);
      const sendArgs = mockSendTransaction.mock.calls[0]?.[0] as {
        to: string;
        data: string;
      };
      expect(sendArgs.to).toBe(VALID_UPTO_ACCEPT.asset.toLowerCase());
      expect(sendArgs.data).toBe('0xencodedapprovedata');
      expect(mockWaitForTransactionReceipt).toHaveBeenCalledWith({ hash: MOCK_APPROVE_TX_HASH });
      expect(mockReadContract).toHaveBeenCalledTimes(2); // before + after
      expect(result.paymentSignatureBase64).toBeDefined();
    });

    it('throws when approve transaction reverts on-chain', async () => {
      mockReadContract.mockResolvedValueOnce(0n);
      mockWaitForTransactionReceipt.mockResolvedValueOnce({
        status: 'reverted',
        blockNumber: 1n,
      });

      await expect(signPayment({ wallet: MOCK_WALLET, accept: VALID_UPTO_ACCEPT })).rejects.toThrow(
        'reverted on-chain'
      );
    });

    it('skipPermit2Approval bypasses the allowance check entirely', async () => {
      mockReadContract.mockResolvedValueOnce(0n); // would normally trigger approve

      await signPayment({
        wallet: MOCK_WALLET,
        accept: VALID_UPTO_ACCEPT,
        skipPermit2Approval: true,
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
