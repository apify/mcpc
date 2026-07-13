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
import type { X402SchemePreference } from '../types.js';

const logger = createLogger('x402-signer');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const X402_VERSION = 2;
const USDC_DECIMALS = 6;

/** Fallback expiry when neither the caller nor the `accept` advertise one. */
export const DEFAULT_PAYMENT_EXPIRY_SECONDS = 3600;

/** Canonical Permit2 contract address (CREATE2, same on all EVM chains). */
const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

/** x402 upto scheme Permit2 proxy contract address (vanity: 0x4020…0002). */
const X402_UPTO_PERMIT2_PROXY = '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002';

/** Clock-skew grace period for validAfter (seconds). */
const VALID_AFTER_CLOCK_SKEW_SECONDS = 600;

/** Maximum uint256 — used for unlimited Permit2 allowance approval. */
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
}

const NETWORKS: Record<string, NetworkConfig> = {
  [`eip155:${base.id}`]: {
    chain: base,
    networkId: `eip155:${base.id}`,
    rpcUrl: 'https://mainnet.base.org',
    label: 'Base Mainnet',
  },
  [`eip155:${baseSepolia.id}`]: {
    chain: baseSepolia,
    networkId: `eip155:${baseSepolia.id}`,
    rpcUrl: 'https://sepolia.base.org',
    label: 'Base Sepolia (testnet)',
  },
};

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
  /** Override expiry in seconds (default: `accept.maxTimeoutSeconds` or `DEFAULT_PAYMENT_EXPIRY_SECONDS`) */
  expiryOverrideSecs?: number;
  /**
   * For the upto scheme: skip the on-chain Permit2 allowance check & auto-approval.
   * Default false — the signer will check `USDC.allowance(wallet, PERMIT2)` and submit a
   * one-time `USDC.approve(PERMIT2, MAX_UINT256)` transaction if the allowance is short of
   * the amount being authorized. Pass `true` if you've already approved or want to manage
   * approvals yourself.
   */
  skipPermit2Approval?: boolean;
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
  return a.scheme === 'exact' && Boolean(a.payTo && a.amount && a.network && a.asset);
}

function isValidUptoAccept(a: PaymentRequiredAccept): boolean {
  return (
    a.scheme === 'upto' &&
    Boolean(a.payTo && a.amount && a.network && a.asset) &&
    Boolean(a.extra?.facilitatorAddress)
  );
}

/**
 * Select the best accept entry from the array based on user preference.
 *
 * - `auto`   → prefer valid `upto`, fallback to valid `exact`
 * - `upto`   → require valid `upto`; undefined if none
 * - `exact`  → require valid `exact`; undefined if none
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
    const available = header.accepts.map((a) => a.scheme).join(', ');
    throw new ClientError(
      `No valid "${requested}" scheme found in PAYMENT-REQUIRED accepts. Available: ${available}`
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
  if (accept.scheme === 'upto') {
    return signUptoPayment(input);
  }
  if (accept.scheme === 'exact') {
    return signExactPayment(input);
  }
  throw new ClientError(`Unsupported x402 scheme: ${accept.scheme}`);
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
  const amountAtomicUnits = input.amountOverride ?? BigInt(accept.amount);
  const amountUsd = Number(amountAtomicUnits) / 10 ** USDC_DECIMALS;

  // Resolve expiry
  const expirySeconds =
    (input.expiryOverrideSecs ?? accept.maxTimeoutSeconds) || DEFAULT_PAYMENT_EXPIRY_SECONDS;

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

  const nonce = randomBytes32();
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + expirySeconds);

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
      validAfter: 0n,
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
        validAfter: '0',
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

/**
 * Ensures the wallet has approved Permit2 to spend at least `requiredAmount` of `tokenAddress`.
 * If the existing allowance is short, sends a one-time `approve(PERMIT2, MAX_UINT256)` transaction
 * and waits for confirmation. Logs each step. Idempotent — if allowance is already sufficient,
 * does nothing.
 *
 * Required because the upto scheme uses Permit2 (`permitWitnessTransferFrom`), which can only
 * pull tokens that the wallet has previously approved Permit2 to spend.
 * Spec: https://github.com/coinbase/x402/blob/main/specs/schemes/upto/scheme_upto_evm.md#phase-1-one-time-gas-approval
 */
async function ensurePermit2Allowance(params: {
  wallet: SignerWallet;
  tokenAddress: Hex;
  requiredAmount: bigint;
  networkConfig: NetworkConfig;
}): Promise<{ approveTxHash?: Hex; previousAllowance: bigint; newAllowance: bigint }> {
  const { wallet, tokenAddress, requiredAmount, networkConfig } = params;
  const walletAddress = getAddress(wallet.address) as Hex;
  const permit2 = getAddress(PERMIT2_ADDRESS) as Hex;

  const publicClient = createPublicClient({
    chain: networkConfig.chain,
    transport: http(networkConfig.rpcUrl),
  });

  const currentAllowance = (await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ALLOWANCE_ABI,
    functionName: 'allowance',
    args: [walletAddress, permit2],
  })) as bigint;

  if (currentAllowance >= requiredAmount) {
    logger.debug(
      `Permit2 allowance sufficient (${currentAllowance.toString()} >= ${requiredAmount.toString()})`
    );
    return { previousAllowance: currentAllowance, newAllowance: currentAllowance };
  }

  logger.info(
    `Permit2 allowance is ${currentAllowance.toString()} < ${requiredAmount.toString()} required. Submitting one-time approve(MAX_UINT256) transaction…`
  );

  const account = privateKeyToAccount(wallet.privateKey as Hex);
  const walletClient = createWalletClient({
    account,
    chain: networkConfig.chain,
    transport: http(networkConfig.rpcUrl),
  });

  const approveData = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [permit2, MAX_UINT256],
  });

  const approveTxHash = await walletClient.sendTransaction({
    to: tokenAddress,
    data: approveData,
  });

  logger.info(`Permit2 approve tx submitted: ${approveTxHash}. Waiting for confirmation…`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
  if (receipt.status !== 'success') {
    throw new ClientError(
      `Permit2 approve transaction reverted on-chain: ${approveTxHash}. Inspect at ${networkConfig.label} explorer.`
    );
  }

  // Re-read to confirm.
  const newAllowance = (await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ALLOWANCE_ABI,
    functionName: 'allowance',
    args: [walletAddress, permit2],
  })) as bigint;

  logger.info(
    `Permit2 approve confirmed in block ${receipt.blockNumber}. New allowance: ${newAllowance.toString()}`
  );

  return { approveTxHash, previousAllowance: currentAllowance, newAllowance };
}

/**
 * Sign an x402 `upto` scheme payment using Permit2 permitWitnessTransferFrom.
 * The payer authorizes a maximum amount; the facilitator settles the actual usage later.
 *
 * Before signing, this checks `USDC.allowance(wallet, PERMIT2)` and, if insufficient, submits
 * a one-time `USDC.approve(PERMIT2, MAX_UINT256)` transaction so the upto scheme can actually
 * settle on-chain. Pass `skipPermit2Approval: true` to bypass the check.
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
  const amountAtomicUnits = input.amountOverride ?? BigInt(accept.amount);
  const amountUsd = Number(amountAtomicUnits) / 10 ** USDC_DECIMALS;

  // Resolve expiry
  const expirySeconds =
    (input.expiryOverrideSecs ?? accept.maxTimeoutSeconds) || DEFAULT_PAYMENT_EXPIRY_SECONDS;

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

  // Ensure Permit2 has sufficient ERC-20 allowance from the payer's wallet.
  // Without this, the on-chain settle will revert. One-time setup per (wallet, token).
  if (!input.skipPermit2Approval) {
    await ensurePermit2Allowance({
      wallet,
      tokenAddress: getAddress(accept.asset) as Hex,
      requiredAmount: amountAtomicUnits,
      networkConfig,
    });
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
