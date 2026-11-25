/**
 * x402 payment signing logic
 * Reusable module for signing EIP-3009 TransferWithAuthorization (exact scheme)
 * and Permit2 permitWitnessTransferFrom (upto scheme) payments.
 * Used by both the CLI `x402 sign` command and the fetch middleware.
 */

import {
  base,
  baseSepolia,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  privateKeyToAccount,
  type Hex,
} from './viem.js';
import { ClientError } from '../errors.js';
import { createLogger } from '../logger.js';
import { PaymentRefusedError, atomicUnitsToUsd, formatUsd, parseAtomicAmount } from './limits.js';
import type { X402SchemePreference } from '../types.js';

const logger = createLogger('x402-signer');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const X402_VERSION = 2;

/** Fallback expiry when neither the caller nor the `accept` advertise one. */
export const DEFAULT_PAYMENT_EXPIRY_SECONDS = 3600;

/**
 * Longest validity mcpc gives a payment on a server's say-so. `maxTimeoutSeconds` is
 * server-controlled, and a signed authorization can be redeemed until it expires, so an
 * unclamped value would let a server hold a live claim on the wallet for years.
 */
export const MAX_PAYMENT_EXPIRY_SECONDS = 3600;

/** Canonical Permit2 contract address (CREATE2, same on all EVM chains). */
const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

/** x402 upto scheme Permit2 proxy contract address (vanity: 0x4020…0002). */
const X402_UPTO_PERMIT2_PROXY = '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002';

/** Clock-skew grace period for validAfter (seconds). */
const VALID_AFTER_CLOCK_SKEW_SECONDS = 600;

/** Maximum uint256 — the standard "unlimited" Permit2 allowance. */
const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');

/** Minimal ERC-20 ABI fragments for allowance / approve. */
const ERC20_ALLOWANCE_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const ERC20_APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const UPTO_PERMIT2_WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'Witness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  Witness: [
    { name: 'to', type: 'address' },
    { name: 'facilitator', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
  ],
} as const;

// ---------------------------------------------------------------------------
// Network configs
// ---------------------------------------------------------------------------

interface NetworkConfig {
  chain: typeof base | typeof baseSepolia;
  networkId: string;
  rpcUrl: string;
  label: string;
  /** Short name accepted by `mcpc x402 approve --network`. */
  alias: string;
  /**
   * Circle's USDC contract on this chain — the only token mcpc signs payments in. The
   * `asset` of a payment requirement is server-controlled; signing for whatever it names
   * would let a server draw on any ERC-20 the wallet happens to hold.
   */
  usdcAddress: string;
}

const NETWORKS: Record<string, NetworkConfig> = {
  [`eip155:${base.id}`]: {
    chain: base,
    networkId: `eip155:${base.id}`,
    rpcUrl: 'https://mainnet.base.org',
    label: 'Base Mainnet',
    alias: 'base',
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  [`eip155:${baseSepolia.id}`]: {
    chain: baseSepolia,
    networkId: `eip155:${baseSepolia.id}`,
    rpcUrl: 'https://sepolia.base.org',
    label: 'Base Sepolia (testnet)',
    alias: 'base-sepolia',
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
};

/**
 * Whether mcpc can sign payments on the given network (CAIP-2 id, e.g. `eip155:8453`).
 * Servers may offer the same price on several chains at once (Base, Solana, ...); only
 * the networks in `NETWORKS` are supported.
 */
export function isSupportedNetwork(network: string): boolean {
  return Object.hasOwn(NETWORKS, network);
}

/** Whether `asset` is the USDC contract of the given (supported) network. */
export function isSupportedAsset(network: string, asset: unknown): boolean {
  return (
    isSupportedNetwork(network) &&
    typeof asset === 'string' &&
    asset.toLowerCase() === NETWORKS[network]?.usdcAddress.toLowerCase()
  );
}

/** The names `mcpc x402 approve --network` accepts, mainnet first. */
export const NETWORK_ALIASES: string[] = Object.values(NETWORKS).map((n) => n.alias);

/**
 * Identifies the terms a payment was signed for. A signature is only ever reused for a
 * request with the same key, so one signed for a cheap tool is never offered for a dear
 * one, nor to a different payee.
 */
export function paymentTermsKey(accept: PaymentRequiredAccept): string {
  return [accept.scheme, accept.network, accept.asset, accept.payTo, accept.amount]
    .map((part) => String(part).toLowerCase())
    .join('|');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PaymentRequiredAccept {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: { name?: string; version?: string; facilitatorAddress?: string };
}

export interface PaymentRequiredHeader {
  x402Version: number;
  resource?: { url?: string; description?: string; mimeType?: string };
  accepts: PaymentRequiredAccept[];
}

export type SchemePreference = X402SchemePreference;

/** Minimal wallet info needed for signing */
export interface SignerWallet {
  privateKey: string; // Hex with 0x prefix
  address: string;
}

export interface SignPaymentInput {
  wallet: SignerWallet;
  accept: PaymentRequiredAccept;
  resource?: PaymentRequiredHeader['resource'];
  /** Override amount in atomic units (default: from accept.amount) */
  amountOverride?: bigint;
  /**
   * Override expiry in seconds. Without it the server's `accept.maxTimeoutSeconds` applies,
   * clamped to `MAX_PAYMENT_EXPIRY_SECONDS`; the caller's own override is taken as given.
   */
  expiryOverrideSecs?: number;
  /**
   * For the upto scheme: skip the read-only check that the wallet has approved Permit2 to
   * spend the amount being authorized. Without that approval the signature is valid but
   * can never settle, so by default signing is refused with a pointer to
   * `mcpc x402 approve`. Signing itself never sends a transaction.
   */
  skipPermit2Check?: boolean;
}

export interface SignPaymentResult {
  /** Base64-encoded payment signature header value */
  paymentSignatureBase64: string;
  /** Signer address */
  from: string;
  /** Recipient address */
  to: string;
  /** Amount in USD */
  amountUsd: number;
  /** Amount in atomic units */
  amountAtomicUnits: bigint;
  /** Network label */
  networkLabel: string;
  /** Expiry timestamp */
  expiresAt: Date;
}

/** Outcome of `approvePermit2()`. Allowances are USDC atomic units. */
export interface Permit2ApprovalResult {
  network: string;
  networkLabel: string;
  token: string;
  spender: string;
  previousAllowance: bigint;
  allowance: bigint;
  /** Hash of the `approve` transaction; absent when the allowance already matched. */
  transaction?: string;
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function randomBytes32(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ('0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')) as Hex;
}

/**
 * 256-bit random nonce for Permit2, encoded as a uint256 *decimal* string.
 *
 * Permit2 (used by the upto scheme) expects a uint256 nonce — distinct from
 * EIP-3009's `bytes32` nonce. Sending the hex-encoded form to a strict facilitator
 * (e.g. CDP) makes the whole `permit2Authorization` payload fail JSON-schema validation.
 *
 * Matches the official x402 SDK's `createPermit2Nonce()` byte-for-byte.
 */
function randomPermit2Nonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = '0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return BigInt(hex).toString();
}

// ---------------------------------------------------------------------------
// Scheme selection
// ---------------------------------------------------------------------------

function isValidExactAccept(a: PaymentRequiredAccept): boolean {
  return (
    a.scheme === 'exact' &&
    Boolean(a.payTo && a.amount && a.network && a.asset) &&
    isSupportedAsset(a.network, a.asset)
  );
}

function isValidUptoAccept(a: PaymentRequiredAccept): boolean {
  return (
    a.scheme === 'upto' &&
    Boolean(a.payTo && a.amount && a.network && a.asset) &&
    Boolean(a.extra?.facilitatorAddress) &&
    isSupportedAsset(a.network, a.asset)
  );
}

/**
 * Select the best accept entry from the array based on user preference.
 *
 * - `auto`   → prefer valid `upto`, fallback to valid `exact`
 * - `upto`   → require valid `upto`; undefined if none
 * - `exact`  → require valid `exact`; undefined if none
 *
 * Entries mcpc will not sign for — a network it does not support, or a token other than
 * that network's USDC (see `isSupportedAsset`) — are skipped, so a server that lists a
 * Solana option before the Base one still gets a Base payment.
 */
export function selectAcceptEntry(
  accepts: PaymentRequiredAccept[],
  preference: SchemePreference = 'auto'
): PaymentRequiredAccept | undefined {
  if (preference === 'upto') {
    return accepts.find(isValidUptoAccept);
  }
  if (preference === 'exact') {
    return accepts.find(isValidExactAccept);
  }
  // auto: prefer upto, fallback exact
  const upto = accepts.find(isValidUptoAccept);
  if (upto) return upto;
  return accepts.find(isValidExactAccept);
}

// ---------------------------------------------------------------------------
// PAYMENT-REQUIRED header parsing
// ---------------------------------------------------------------------------

/**
 * Parse a base64-encoded PAYMENT-REQUIRED header value.
 * Returns the parsed header and the selected accept entry based on scheme preference.
 */
export function parsePaymentRequired(
  base64Value: string,
  schemePreference: SchemePreference = 'auto'
): {
  header: PaymentRequiredHeader;
  accept: PaymentRequiredAccept;
} {
  let decoded: string;
  try {
    decoded = Buffer.from(base64Value, 'base64').toString('utf-8');
  } catch {
    throw new ClientError('Failed to base64-decode the PAYMENT-REQUIRED value.');
  }

  let header: PaymentRequiredHeader;
  try {
    header = JSON.parse(decoded) as PaymentRequiredHeader;
  } catch {
    throw new ClientError('PAYMENT-REQUIRED header is not valid JSON after base64 decoding.');
  }

  if (!header.accepts || !Array.isArray(header.accepts) || header.accepts.length === 0) {
    throw new ClientError('PAYMENT-REQUIRED header has no "accepts" entries.');
  }

  const accept = selectAcceptEntry(header.accepts, schemePreference);
  if (!accept) {
    const requested = schemePreference === 'auto' ? 'exact or upto' : schemePreference;
    const offered = header.accepts
      .map((a) => `${a.scheme} on ${a.network} (asset ${a.asset})`)
      .join(', ');
    throw new ClientError(
      `No valid "${requested}" scheme on a supported network found in PAYMENT-REQUIRED accepts. ` +
        `Offered: ${offered}. Supported networks: ${Object.keys(NETWORKS).join(', ')}, ` +
        `paid in USDC only`
    );
  }

  if (!accept.payTo || !accept.amount || !accept.network || !accept.asset) {
    throw new ClientError(
      'PAYMENT-REQUIRED accept entry is missing required fields (payTo, amount, network, asset).'
    );
  }

  return { header, accept };
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Sign an x402 payment and return a base64-encoded PAYMENT-SIGNATURE header value.
 * Delegates to scheme-specific signers based on `accept.scheme`.
 */
export async function signPayment(input: SignPaymentInput): Promise<SignPaymentResult> {
  const { accept } = input;
  logger.debug(
    `Signing x402 payment: scheme=${accept.scheme} network=${accept.network} amount=${accept.amount} asset=${accept.asset} payTo=${accept.payTo} facilitator=${accept.extra?.facilitatorAddress ?? '<n/a>'}`
  );
  if (accept.scheme !== 'upto' && accept.scheme !== 'exact') {
    throw new ClientError(`Unsupported x402 scheme: ${accept.scheme}`);
  }
  const networkConfig = NETWORKS[accept.network];
  if (networkConfig && !isSupportedAsset(accept.network, accept.asset)) {
    throw new PaymentRefusedError(
      `x402 payment refused: the server asks to be paid in token ${accept.asset}, but mcpc only ` +
        `pays in USDC (${networkConfig.usdcAddress} on ${networkConfig.label}).`
    );
  }
  return accept.scheme === 'upto' ? signUptoPayment(input) : signExactPayment(input);
}

/**
 * How long a payment stays valid. The caller's override is taken as given; the server's
 * `maxTimeoutSeconds` is clamped, and anything that is not a positive number of seconds
 * gets the default.
 */
function resolveExpirySeconds(input: SignPaymentInput): number {
  if (input.expiryOverrideSecs) {
    return input.expiryOverrideSecs;
  }
  const requested = input.accept.maxTimeoutSeconds;
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_PAYMENT_EXPIRY_SECONDS;
  }
  return Math.min(Math.floor(requested) || 1, MAX_PAYMENT_EXPIRY_SECONDS);
}

/**
 * Sign an x402 `exact` scheme payment using EIP-3009 TransferWithAuthorization.
 */
async function signExactPayment(input: SignPaymentInput): Promise<SignPaymentResult> {
  const { wallet, accept, resource } = input;

  // Resolve network
  const networkConfig = NETWORKS[accept.network];
  if (!networkConfig) {
    throw new ClientError(
      `Unknown network "${accept.network}" in payment requirements. Supported: ${Object.keys(NETWORKS).join(', ')}`
    );
  }

  // Resolve amount
  const amountAtomicUnits = input.amountOverride ?? parseAtomicAmount(accept.amount);
  const amountUsd = atomicUnitsToUsd(amountAtomicUnits);

  // Resolve expiry
  const expirySeconds = resolveExpirySeconds(input);

  // EIP-3009 domain
  const eip3009Name = accept.extra?.name ?? 'USDC';
  const eip3009Version = accept.extra?.version ?? '2';

  // Sign
  const account = privateKeyToAccount(wallet.privateKey as Hex);
  const walletClient = createWalletClient({
    account,
    chain: networkConfig.chain,
    transport: http(networkConfig.rpcUrl),
  });

  // Like the upto scheme below, the window opens slightly in the past (clock skew) rather
  // than at 0, so the authorization is bounded on both sides.
  const nonce = randomBytes32();
  const now = Math.floor(Date.now() / 1000);
  const validAfter = BigInt(now - VALID_AFTER_CLOCK_SKEW_SECONDS);
  const validBefore = BigInt(now + expirySeconds);

  const signature = await walletClient.signTypedData({
    domain: {
      name: eip3009Name,
      version: eip3009Version,
      chainId: networkConfig.chain.id,
      verifyingContract: accept.asset as Hex,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: account.address,
      to: accept.payTo as Hex,
      value: amountAtomicUnits,
      validAfter,
      validBefore,
      nonce,
    },
  });

  // Build x402 payload
  const paymentPayload = {
    x402Version: X402_VERSION,
    resource: resource ?? {
      url: 'https://mcp.apify.com/mcp',
      description: 'MCP Server',
      mimeType: 'application/json',
    },
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: accept.payTo,
        value: amountAtomicUnits.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
    accepted: {
      scheme: 'exact',
      network: networkConfig.networkId,
      asset: accept.asset,
      amount: amountAtomicUnits.toString(),
      payTo: accept.payTo,
      maxTimeoutSeconds: expirySeconds,
      extra: { name: eip3009Name, version: eip3009Version },
    },
  };

  const paymentSignatureBase64 = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

  return {
    paymentSignatureBase64,
    from: account.address,
    to: accept.payTo,
    amountUsd,
    amountAtomicUnits,
    networkLabel: networkConfig.label,
    expiresAt: new Date(Number(validBefore) * 1000),
  };
}

/** Read `USDC.allowance(wallet, PERMIT2)` on the given network. No transaction, no gas. */
async function readPermit2Allowance(
  wallet: SignerWallet,
  networkConfig: NetworkConfig
): Promise<bigint> {
  const publicClient = createPublicClient({
    chain: networkConfig.chain,
    transport: http(networkConfig.rpcUrl),
  });
  return (await publicClient.readContract({
    address: getAddress(networkConfig.usdcAddress) as Hex,
    abi: ERC20_ALLOWANCE_ABI,
    functionName: 'allowance',
    args: [getAddress(wallet.address) as Hex, getAddress(PERMIT2_ADDRESS) as Hex],
  })) as bigint;
}

/**
 * Resolve a network given as `base` / `base-sepolia` or as a CAIP-2 id.
 */
function resolveNetwork(network: string): NetworkConfig {
  const config =
    NETWORKS[network] ?? Object.values(NETWORKS).find((n) => n.alias === network.toLowerCase());
  if (!config) {
    throw new ClientError(
      `Unknown network "${network}". Supported: ${Object.values(NETWORKS)
        .map((n) => n.alias)
        .join(', ')}`
    );
  }
  return config;
}

/**
 * Set the wallet's Permit2 allowance for USDC: the one-time on-chain step the upto scheme
 * needs, since Permit2 (`permitWitnessTransferFrom`) can only pull tokens the wallet has
 * approved it to spend. Sends an `approve` transaction (costs gas) unless the allowance is
 * already what was asked for, and waits for it to confirm.
 *
 * This is only ever run by `mcpc x402 approve`, never as a side effect of signing a
 * payment, and only for the network's USDC contract — a server cannot trigger it or choose
 * the token.
 * Spec: https://github.com/coinbase/x402/blob/main/specs/schemes/upto/scheme_upto_evm.md#phase-1-one-time-gas-approval
 *
 * @param allowance - Allowance to set in USDC atomic units; default unlimited, `0n` revokes
 */
export async function approvePermit2(params: {
  wallet: SignerWallet;
  network: string;
  allowance?: bigint;
}): Promise<Permit2ApprovalResult> {
  const { wallet } = params;
  const networkConfig = resolveNetwork(params.network);
  const token = getAddress(networkConfig.usdcAddress) as Hex;
  const permit2 = getAddress(PERMIT2_ADDRESS) as Hex;
  const target = params.allowance ?? MAX_UINT256;

  const result = {
    network: networkConfig.networkId,
    networkLabel: networkConfig.label,
    token,
    spender: permit2,
  };

  const previousAllowance = await readPermit2Allowance(wallet, networkConfig);
  // An unlimited request is satisfied by any allowance that is already effectively
  // unlimited (USDC does not decrement a max allowance, other amounts must match).
  const alreadySet =
    previousAllowance === target || (target === MAX_UINT256 && previousAllowance >= MAX_UINT256);
  if (alreadySet) {
    logger.debug(`Permit2 allowance already ${previousAllowance.toString()}, nothing to send`);
    return { ...result, previousAllowance, allowance: previousAllowance };
  }

  const account = privateKeyToAccount(wallet.privateKey as Hex);
  const walletClient = createWalletClient({
    account,
    chain: networkConfig.chain,
    transport: http(networkConfig.rpcUrl),
  });
  const publicClient = createPublicClient({
    chain: networkConfig.chain,
    transport: http(networkConfig.rpcUrl),
  });

  const transaction = await walletClient.sendTransaction({
    to: token,
    data: encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: 'approve',
      args: [permit2, target],
    }),
  });
  logger.info(`Permit2 approve tx submitted: ${transaction}. Waiting for confirmation…`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: transaction });
  if (receipt.status !== 'success') {
    throw new ClientError(
      `Permit2 approve transaction reverted on-chain: ${transaction}. Inspect at ${networkConfig.label} explorer.`
    );
  }

  const allowance = await readPermit2Allowance(wallet, networkConfig);
  logger.info(`Permit2 approve confirmed in block ${receipt.blockNumber}`);
  return { ...result, previousAllowance, allowance, transaction };
}

/**
 * Sign an x402 `upto` scheme payment using Permit2 permitWitnessTransferFrom.
 * The payer authorizes a maximum amount; the facilitator settles the actual usage later.
 *
 * Before signing, this reads `USDC.allowance(wallet, PERMIT2)` and refuses when it is short
 * of the amount: such a payment could never settle. Granting the allowance is the user's
 * explicit `mcpc x402 approve`; signing sends no transaction. Pass `skipPermit2Check: true`
 * to sign without the read.
 */
async function signUptoPayment(input: SignPaymentInput): Promise<SignPaymentResult> {
  const { wallet, accept, resource } = input;

  // Resolve network
  const networkConfig = NETWORKS[accept.network];
  if (!networkConfig) {
    throw new ClientError(
      `Unknown network "${accept.network}" in payment requirements. Supported: ${Object.keys(NETWORKS).join(', ')}`
    );
  }

  // Resolve amount (max authorization cap)
  const amountAtomicUnits = input.amountOverride ?? parseAtomicAmount(accept.amount);
  const amountUsd = atomicUnitsToUsd(amountAtomicUnits);

  // Resolve expiry
  const expirySeconds = resolveExpirySeconds(input);

  // Validate facilitator address (required by upto scheme for witness binding)
  const facilitatorAddress = accept.extra?.facilitatorAddress;
  if (!facilitatorAddress) {
    throw new ClientError(
      'upto scheme requires facilitatorAddress in paymentRequirements.extra. ' +
        'Ensure the server is configured with an upto facilitator.'
    );
  }

  // EIP-3009 metadata (used for token contract identification in extra)
  const tokenName = accept.extra?.name ?? 'USDC';
  const tokenVersion = accept.extra?.version ?? '2';

  // Permit2 must hold enough ERC-20 allowance from the payer's wallet, or the on-chain
  // settle reverts. One-time setup per (wallet, network), done with `mcpc x402 approve`.
  if (!input.skipPermit2Check) {
    const allowance = await readPermit2Allowance(wallet, networkConfig);
    if (allowance < amountAtomicUnits) {
      throw new PaymentRefusedError(
        `x402 payment refused: the "upto" scheme needs a one-time on-chain approval that lets ` +
          `Permit2 spend this wallet's USDC on ${networkConfig.label} ` +
          `(${formatUsd(amountAtomicUnits)} needed, ${formatUsd(allowance)} approved).\n` +
          `To approve, run: mcpc x402 approve --network ${networkConfig.alias}\n` +
          `To pay without it, use the "exact" scheme: --x402 exact`
      );
    }
  }

  // Sign with Permit2 domain (NOT the token contract domain)
  const account = privateKeyToAccount(wallet.privateKey as Hex);
  const walletClient = createWalletClient({
    account,
    chain: networkConfig.chain,
    transport: http(networkConfig.rpcUrl),
  });

  // Permit2 expects a uint256 nonce as a *decimal* string — NOT a bytes32 hex string
  // like EIP-3009 uses. Strict facilitators (CDP) reject the hex form with a misleading
  // "schema requires authorization, transaction" error.
  const nonce = randomPermit2Nonce();
  const now = Math.floor(Date.now() / 1000);
  const validAfter = (now - VALID_AFTER_CLOCK_SKEW_SECONDS).toString();
  const deadline = (now + expirySeconds).toString();

  if (BigInt(deadline) <= BigInt(validAfter)) {
    throw new ClientError(
      `Invalid time window: deadline (${deadline}) must be after validAfter (${validAfter}). ` +
        `Check that maxTimeoutSeconds (${accept.maxTimeoutSeconds}) is positive.`
    );
  }

  const chainId = networkConfig.chain.id;

  const signature = await walletClient.signTypedData({
    domain: {
      name: 'Permit2',
      chainId,
      verifyingContract: PERMIT2_ADDRESS as Hex,
    },
    types: UPTO_PERMIT2_WITNESS_TYPES,
    primaryType: 'PermitWitnessTransferFrom',
    message: {
      permitted: {
        token: getAddress(accept.asset),
        amount: amountAtomicUnits,
      },
      spender: getAddress(X402_UPTO_PERMIT2_PROXY),
      nonce: BigInt(nonce),
      deadline: BigInt(deadline),
      witness: {
        to: getAddress(accept.payTo),
        facilitator: getAddress(facilitatorAddress),
        validAfter: BigInt(validAfter),
      },
    },
  });

  // Build x402 payload
  const paymentPayload = {
    x402Version: X402_VERSION,
    resource: resource ?? {
      url: 'https://mcp.apify.com/mcp',
      description: 'MCP Server',
      mimeType: 'application/json',
    },
    payload: {
      signature,
      permit2Authorization: {
        permitted: {
          token: getAddress(accept.asset),
          amount: amountAtomicUnits.toString(),
        },
        from: account.address,
        spender: X402_UPTO_PERMIT2_PROXY,
        nonce,
        deadline,
        witness: {
          to: getAddress(accept.payTo),
          facilitator: getAddress(facilitatorAddress),
          validAfter,
        },
      },
    },
    accepted: {
      scheme: 'upto',
      network: networkConfig.networkId,
      asset: accept.asset,
      amount: amountAtomicUnits.toString(),
      payTo: accept.payTo,
      maxTimeoutSeconds: expirySeconds,
      // `facilitatorAddress` is guaranteed non-empty here — the early throw above rejects
      // an upto accept without it. Spread-with-guard would be dead code.
      extra: { name: tokenName, version: tokenVersion, facilitatorAddress },
    },
  };

  const paymentSignatureBase64 = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

  return {
    paymentSignatureBase64,
    from: account.address,
    to: accept.payTo,
    amountUsd,
    amountAtomicUnits,
    networkLabel: networkConfig.label,
    expiresAt: new Date(Number(deadline) * 1000),
  };
}
