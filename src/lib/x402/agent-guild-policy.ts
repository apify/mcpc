/**
 * Agent Guild x402 payment policy preset.
 *
 * Buys one short-lived AGPD-1 decision with an isolated, strictly pinned x402
 * transport, then verifies the credential and every payment field locally.
 * The protected payment is never signed unless the sealed decision is allow.
 */

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import type { FetchLike } from '@modelcontextprotocol/client';
import { createX402FetchMiddleware } from './fetch-middleware.js';
import type { X402PaymentPolicy } from './payment-policy.js';
import type { SignerWallet } from './signer.js';

const DEFAULT_AGENT_GUILD_HOST = 'https://agent-guild-5d5r.onrender.com';
const BASE_MAINNET = 'eip155:8453';
const BASE_MAINNET_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const AGENT_GUILD_TREASURY = '0xaa4e3ba0eb5f564cab54ddc08f5baafb3d4ca8e5';
// The ordinary AGPD-1 decision currently costs 10 credits = $0.01. This
// hard ceiling intentionally requires a reviewed client update if that price rises.
const MAX_DECISION_FEE_ATOMIC = 10_000n;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export interface AgentGuildPolicyOptions {
  baseFetch: FetchLike;
  wallet: SignerWallet;
  /** Test/integration seam. Production callers should omit this. */
  decisionFetch?: FetchLike;
  host?: string;
  maxRisk?: number;
  minConfidence?: number;
  ttlSeconds?: number;
  /** Required local ceiling for the protected payment, in token atomic units. */
  maxAmountAtomic?: string;
  now?: () => Date;
}

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
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('credential contains a non-finite number');
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('credential contains an unsupported value');
  return encoded;
}

function decodeBase58(value: string): Buffer {
  let number = 0n;
  for (const char of value) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('invalid base58 value');
    number = number * 58n + BigInt(index);
  }
  let hex = number.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = hex === '0' ? [] : [...Buffer.from(hex, 'hex')];
  for (const char of value) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

function publicKeyFromDid(did: string): Buffer {
  const multibase = did.startsWith('did:key:') ? did.slice(8) : did;
  if (!multibase.startsWith('z')) throw new Error('unsupported issuer DID');
  const decoded = decodeBase58(multibase.slice(1));
  if (decoded[0] !== 0xed || decoded[1] !== 0x01 || decoded.length !== 34) {
    throw new Error('issuer DID is not an Ed25519 did:key');
  }
  return decoded.subarray(2);
}

function verifyCredential(credential: Record<string, unknown>): boolean {
  try {
    const proof = credential.proof as Record<string, unknown> | undefined;
    if (
      proof?.type !== 'DataIntegrityProof' ||
      proof.cryptosuite !== 'eddsa-jcs-2022' ||
      typeof proof.proofValue !== 'string' ||
      !proof.proofValue.startsWith('z')
    ) {
      return false;
    }
    const issuer = String(credential.issuer || '');
    const verificationMethod = String(proof.verificationMethod || '');
    if (!issuer || verificationMethod.split('#', 1)[0] !== issuer) return false;

    const proofValue = proof.proofValue;
    const { proofValue: _proofValue, ...proofConfig } = proof;
    const { proof: _proof, ...document } = credential;
    if (
      '@context' in proofConfig &&
      canonicalJson(proofConfig['@context']) !== canonicalJson(document['@context'] ?? null)
    ) {
      return false;
    }
    const hashData = Buffer.concat([
      createHash('sha256').update(canonicalJson(proofConfig)).digest(),
      createHash('sha256').update(canonicalJson(document)).digest(),
    ]);
    const rawKey = publicKeyFromDid(issuer);
    const derKey = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]);
    return verifySignature(
      null,
      hashData,
      createPublicKey({ key: derKey, format: 'der', type: 'spki' }),
      decodeBase58(proofValue.slice(1))
    );
  } catch {
    return false;
  }
}

function exactAddress(value: unknown, label: string): string {
  const address = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    throw new Error(`${label} is not an exact EVM address`);
  }
  return address;
}

async function jsonResponse(fetcher: FetchLike, url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetcher(url, init);
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    throw new Error(`redirect refused for ${new URL(url).pathname}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${new URL(url).pathname}`);
  return response.json();
}

/** Create mcpc's fail-closed Agent Guild policy preset. */
export function createAgentGuildPaymentPolicy({
  baseFetch,
  wallet,
  decisionFetch: suppliedDecisionFetch,
  host = DEFAULT_AGENT_GUILD_HOST,
  maxRisk = 32.99,
  minConfidence = 0.5,
  ttlSeconds = 300,
  maxAmountAtomic,
  now = () => new Date(),
}: AgentGuildPolicyOptions): X402PaymentPolicy {
  const base = host.replace(/\/$/, '');
  if (!maxAmountAtomic || !/^[0-9]+$/.test(maxAmountAtomic) || BigInt(maxAmountAtomic) <= 0n) {
    throw new Error('Agent Guild payment policy requires a positive maxAmountAtomic ceiling');
  }
  const protectedAmountCeiling = BigInt(maxAmountAtomic);
  const baseOrigin = new URL(base).origin;

  const decisionFeePolicy: X402PaymentPolicy = async ({
    paymentRequired,
    selectedRequirements,
    requestUrl,
  }) => {
    try {
      const paymentResource = new URL(String(paymentRequired.resource?.url || ''));
      const decisionRequestUrl = new URL(String(requestUrl || ''));
      const amount = BigInt(String(selectedRequirements.amount || ''));
      const safe =
        decisionRequestUrl.origin === baseOrigin &&
        decisionRequestUrl.pathname === '/wallet-binding/decision' &&
        paymentResource.origin === baseOrigin &&
        paymentResource.pathname === '/wallet-binding/decision' &&
        selectedRequirements.scheme === 'exact' &&
        selectedRequirements.network === BASE_MAINNET &&
        exactAddress(selectedRequirements.asset, 'decision asset') === BASE_MAINNET_USDC &&
        exactAddress(selectedRequirements.payTo, 'decision payTo') === AGENT_GUILD_TREASURY &&
        amount > 0n &&
        amount <= MAX_DECISION_FEE_ATOMIC;
      return safe
        ? undefined
        : { abort: true, reason: 'Agent Guild decision fee exceeded its pinned local terms' };
    } catch {
      return { abort: true, reason: 'Agent Guild decision fee challenge was invalid' };
    }
  };

  return async ({ paymentRequired, selectedRequirements, requestUrl }) => {
    try {
      const resource = String(paymentRequired.resource?.url || '');
      if (!/^https?:\/\//.test(resource)) {
        throw new Error('authoritative payment resource is missing or is not HTTP(S)');
      }
      if (requestUrl && new URL(resource).origin !== new URL(requestUrl).origin) {
        throw new Error('payment resource origin does not match the MCP server origin');
      }
      const amount = String(selectedRequirements.amount || '');
      if (!/^[0-9]+$/.test(amount) || BigInt(amount) <= 0n) {
        throw new Error('amount is not a positive atomic-unit integer');
      }
      if (BigInt(amount) > protectedAmountCeiling) {
        return { abort: true, reason: 'payment exceeds the local maxAmountAtomic ceiling' };
      }
      const expected = {
        scheme: String(selectedRequirements.scheme || ''),
        network: String(selectedRequirements.network || ''),
        asset: exactAddress(selectedRequirements.asset, 'asset'),
        amount,
        pay_to: exactAddress(selectedRequirements.payTo, 'payTo'),
        resource,
      };
      const request = {
        payment: expected,
        capability: null,
        policy: { max_risk: maxRisk, min_confidence: minConfidence },
        ttl_seconds: ttlSeconds,
      };
      // A fresh isolated transport buys exactly this decision. Its narrow local
      // policy pins origin, chain, token, treasury and a $0.01 fee ceiling, so
      // obtaining policy evidence cannot become an unbounded wallet signature.
      const decisionBaseFetch: FetchLike = async (url, init) => {
        if (new URL(String(url)).origin !== baseOrigin) {
          throw new Error('Agent Guild decision request left its pinned origin');
        }
        return baseFetch(url, { ...init, redirect: 'manual' });
      };
      const decisionFetch =
        suppliedDecisionFetch ??
        createX402FetchMiddleware(decisionBaseFetch, {
          wallet,
          paymentCache: { signature: null },
          schemePreference: 'exact',
          paymentPolicy: decisionFeePolicy,
        });
      const credential = (await jsonResponse(decisionFetch, `${base}/wallet-binding/decision`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })) as Record<string, unknown>;
      const issuerDocument = (await jsonResponse(
        baseFetch,
        `${base}/.well-known/agent-guild-did.json`,
        { headers: { accept: 'application/json' }, redirect: 'manual' }
      )) as Record<string, unknown>;
      const subject = (credential.credentialSubject || {}) as Record<string, unknown>;
      const sealedPayment = (subject.payment || {}) as Record<string, unknown>;
      const effectivePolicy = ((subject.policy as Record<string, unknown> | undefined)?.effective ||
        {}) as Record<string, unknown>;
      const validFrom = new Date(String(credential.validFrom || ''));
      const validUntil = new Date(String(credential.validUntil || ''));
      const clock = now();
      const fresh =
        Number.isFinite(validFrom.getTime()) &&
        Number.isFinite(validUntil.getTime()) &&
        validFrom <= clock &&
        clock <= validUntil &&
        validUntil.getTime() - validFrom.getTime() <= ttlSeconds * 1000;
      const exact =
        sealedPayment.scheme === expected.scheme &&
        sealedPayment.network === expected.network &&
        String(sealedPayment.asset || '').toLowerCase() === expected.asset &&
        sealedPayment.amount === expected.amount &&
        String(sealedPayment.pay_to || '').toLowerCase() === expected.pay_to &&
        sealedPayment.resource === expected.resource;
      const policyExact =
        Number(effectivePolicy.max_risk) <= maxRisk &&
        Number(effectivePolicy.min_confidence) >= minConfidence;
      const proofValid = verifyCredential(credential) && credential.issuer === issuerDocument.did;
      if (
        !proofValid ||
        !fresh ||
        !exact ||
        !policyExact ||
        subject.contract !== 'AGPD-1/1.0' ||
        subject.decision !== 'allow'
      ) {
        return {
          abort: true,
          reason:
            typeof subject.reason === 'string' && proofValid && fresh && exact
              ? subject.reason
              : 'Agent Guild decision was invalid, stale, inexact, or did not allow payment',
        };
      }
      return undefined;
    } catch (error) {
      return {
        abort: true,
        reason: `Agent Guild payment verification unavailable: ${(error as Error).message}`,
      };
    }
  };
}
