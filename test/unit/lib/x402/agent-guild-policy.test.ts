import { createHash, generateKeyPairSync, sign as signEd25519, type KeyObject } from 'node:crypto';

import { createAgentGuildPaymentPolicy } from '../../../../src/lib/x402/agent-guild-policy.js';
import type { X402PaymentPolicyContext } from '../../../../src/lib/x402/payment-policy.js';
import type { SignerWallet } from '../../../../src/lib/x402/signer.js';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const NOW = new Date('2026-08-12T12:00:00.000Z');

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function encodeBase58(bytes: Uint8Array): string {
  let number = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let output = '';
  while (number > 0n) {
    output = BASE58[Number(number % 58n)] + output;
    number /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    output = `1${output}`;
  }
  return output || '1';
}

function issuerFixture(): { did: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const multicodec = Buffer.concat([Buffer.from([0xed, 0x01]), rawPublicKey]);
  return { did: `did:key:z${encodeBase58(multicodec)}`, privateKey };
}

function signedDecision(
  issuer: { did: string; privateKey: KeyObject },
  payment: Record<string, unknown>,
  mutate?: (subject: Record<string, unknown>) => void
): Record<string, unknown> {
  const subject: Record<string, unknown> = {
    id: 'did:key:zProvider',
    contract: 'AGPD-1/1.0',
    payment,
    policy: { effective: { max_risk: 32.99, min_confidence: 0.5 } },
    decision: 'allow',
    reason: 'exact signed allow',
  };
  mutate?.(subject);
  const unsigned = {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    id: 'urn:agent-guild:payment-decision:test',
    type: ['VerifiableCredential', 'AgentGuildPaymentDecision'],
    issuer: issuer.did,
    validFrom: '2026-08-12T11:59:00.000Z',
    validUntil: '2026-08-12T12:04:00.000Z',
    credentialSubject: subject,
  };
  const proofConfig = {
    '@context': unsigned['@context'],
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: unsigned.validFrom,
    verificationMethod: `${issuer.did}#${issuer.did.slice(8)}`,
    proofPurpose: 'assertionMethod',
  };
  const hashData = Buffer.concat([
    createHash('sha256').update(canonicalJson(proofConfig)).digest(),
    createHash('sha256').update(canonicalJson(unsigned)).digest(),
  ]);
  const signature = signEd25519(null, hashData, issuer.privateKey);
  return {
    ...unsigned,
    proof: { ...proofConfig, proofValue: `z${encodeBase58(signature)}` },
  };
}

const WALLET: SignerWallet = {
  privateKey: `0x${'11'.repeat(32)}`,
  address: `0x${'88'.repeat(20)}`,
};

const CONTEXT: X402PaymentPolicyContext = {
  paymentRequired: {
    x402Version: 2,
    resource: { url: 'https://seller.example/research/42' },
    accepts: [],
  },
  selectedRequirements: {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: `0x${'77'.repeat(20)}`,
    amount: '25000',
    payTo: `0x${'66'.repeat(20)}`,
    maxTimeoutSeconds: 300,
    extra: {},
  },
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createAgentGuildPaymentPolicy', () => {
  it('allows only a fresh, exact, issuer-pinned signed decision', async () => {
    const issuer = issuerFixture();
    const baseFetch = vi.fn().mockResolvedValue(response({ did: issuer.did }));
    const decisionFetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      return response(signedDecision(issuer, request.payment));
    });
    const policy = createAgentGuildPaymentPolicy({
      baseFetch: baseFetch as never,
      decisionFetch: decisionFetch as never,
      wallet: WALLET,
      host: 'https://guild.example',
      maxAmountAtomic: '1000000',
      now: () => NOW,
    });

    await expect(policy(CONTEXT)).resolves.toBeUndefined();
    expect(decisionFetch).toHaveBeenCalledTimes(1);
    expect(baseFetch).toHaveBeenCalledWith(
      'https://guild.example/.well-known/agent-guild-did.json',
      expect.any(Object)
    );
  });

  it('blocks a signed credential whose amount was changed', async () => {
    const issuer = issuerFixture();
    const baseFetch = vi.fn().mockResolvedValue(response({ did: issuer.did }));
    const decisionFetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      return response(
        signedDecision(issuer, request.payment, (subject) => {
          (subject.payment as Record<string, unknown>).amount = '25001';
        })
      );
    });
    const policy = createAgentGuildPaymentPolicy({
      baseFetch: baseFetch as never,
      decisionFetch: decisionFetch as never,
      wallet: WALLET,
      maxAmountAtomic: '1000000',
      now: () => NOW,
    });

    await expect(policy(CONTEXT)).resolves.toEqual(
      expect.objectContaining({
        abort: true,
        reason: expect.stringMatching(/invalid, stale, inexact/),
      })
    );
  });

  it('fails closed when the decision service is unavailable', async () => {
    const policy = createAgentGuildPaymentPolicy({
      baseFetch: vi.fn() as never,
      decisionFetch: vi.fn().mockRejectedValue(new Error('offline')) as never,
      wallet: WALLET,
      maxAmountAtomic: '1000000',
      now: () => NOW,
    });

    await expect(policy(CONTEXT)).resolves.toEqual({
      abort: true,
      reason: 'Agent Guild payment verification unavailable: offline',
    });
  });

  it('blocks before buying a decision when the payment exceeds the local ceiling', async () => {
    const decisionFetch = vi.fn();
    const policy = createAgentGuildPaymentPolicy({
      baseFetch: vi.fn() as never,
      decisionFetch: decisionFetch as never,
      wallet: WALLET,
      maxAmountAtomic: '24999',
      now: () => NOW,
    });

    await expect(policy(CONTEXT)).resolves.toEqual({
      abort: true,
      reason: 'payment exceeds the local maxAmountAtomic ceiling',
    });
    expect(decisionFetch).not.toHaveBeenCalled();
  });

  it('requires an explicit positive local payment ceiling', () => {
    expect(() =>
      createAgentGuildPaymentPolicy({ baseFetch: vi.fn() as never, wallet: WALLET })
    ).toThrow('requires a positive maxAmountAtomic ceiling');
  });
});
