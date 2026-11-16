/**
 * Nano (XNO) payments for the x402 `exact` scheme on `nano:mainnet`.
 *
 * mcpc builds and signs a Nano state send block for the requested amount and puts it in the
 * PAYMENT-SIGNATURE payload. It never broadcasts the block: the server (or its facilitator)
 * publishes it when it settles, the same way an EIP-3009 authorization is only an offer
 * until the facilitator submits it.
 *
 * Configuration is environment-only:
 * - `MCPC_X402_NANO_KEY`     - the account's 32-byte private key, 64 hex chars (not the seed)
 * - `MCPC_X402_NANO_RPC`     - URL of a Nano node RPC (`account_info`, `block_info`, `work_generate`)
 * - `MCPC_X402_NANO_MAX_RAW` - largest amount, in raw, mcpc may sign in one payment
 *
 * Nothing is signed without the spend cap: a server sets the amount, so the cap is what
 * bounds a single payment.
 */

import { blake2b, ed25519, twistedEdwards } from './viem.js';
import { ClientError } from '../errors.js';

export const NANO_NETWORK = 'nano:mainnet';

const NANO_RPC_TIMEOUT_MILLIS = 60_000;

/** Nano's base32 alphabet (no 0, 2, l, v). */
const ALPHABET = '13456789abcdefghijkmnopqrstuwxyz';

/** State block hash preamble: 31 zero bytes followed by the block type (6 = state). */
const STATE_BLOCK_PREAMBLE = new Uint8Array(32).fill(6, 31);

const MAX_RAW = (1n << 128n) - 1n;

/** Nano signs with ed25519, but with blake2b-512 wherever ed25519 uses sha512. */
const nanoEd25519 = twistedEdwards({ ...ed25519.CURVE, hash: blake2b });

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function bytesToBigInt(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt('0x' + Buffer.from(bytes).toString('hex'));
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  return Uint8Array.from(Buffer.from(value.toString(16).padStart(length * 2, '0'), 'hex'));
}

function hexToBytes(hex: string, length: number, what: string): Uint8Array {
  if (!new RegExp(`^[0-9a-fA-F]{${length * 2}}$`).test(hex)) {
    throw new ClientError(`Invalid ${what}: expected ${length * 2} hex characters`);
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex').toUpperCase();
}

function encodeBase32(value: bigint, chars: number): string {
  let out = '';
  for (let i = chars - 1; i >= 0; i--) {
    out += ALPHABET[Number((value >> BigInt(i * 5)) & 31n)];
  }
  return out;
}

function decodeBase32(text: string): bigint {
  let value = 0n;
  for (const ch of text) {
    value = (value << 5n) | BigInt(ALPHABET.indexOf(ch));
  }
  return value;
}

/** Address checksum: 5-byte blake2b of the public key, byte-reversed. */
function addressChecksum(publicKey: Uint8Array): bigint {
  return bytesToBigInt(blake2b(publicKey, { dkLen: 5 }).reverse());
}

/** Encode a 32-byte public key as a `nano_` address. */
export function nanoAddressFromPublicKey(publicKey: Uint8Array): string {
  return (
    'nano_' +
    encodeBase32(bytesToBigInt(publicKey), 52) +
    encodeBase32(addressChecksum(publicKey), 8)
  );
}

/** Decode a `nano_` (or legacy `xrb_`) address to its public key, verifying the checksum. */
export function publicKeyFromNanoAddress(address: string): Uint8Array {
  // 52 chars carry 4 zero padding bits + the 256-bit key, so the first one is '1' or '3'
  const match = /^(?:nano|xrb)_([13][13456789a-km-uw-z]{51})([13456789a-km-uw-z]{8})$/.exec(
    address
  );
  const [, keyChars, checksumChars] = match ?? [];
  if (!keyChars || !checksumChars) {
    throw new ClientError(`Invalid Nano address: ${address}`);
  }
  const publicKey = bigIntToBytes(decodeBase32(keyChars), 32);
  if (addressChecksum(publicKey) !== decodeBase32(checksumChars)) {
    throw new ClientError(`Invalid Nano address (bad checksum): ${address}`);
  }
  return publicKey;
}

export function nanoPublicKeyFromPrivateKey(privateKey: Uint8Array): Uint8Array {
  return nanoEd25519.getPublicKey(privateKey);
}

// ---------------------------------------------------------------------------
// State blocks
// ---------------------------------------------------------------------------

export interface StateBlockFields {
  account: Uint8Array;
  previous: Uint8Array;
  representative: Uint8Array;
  balance: bigint;
  link: Uint8Array;
}

/** blake2b-256(preamble || account || previous || representative || balance (u128 BE) || link) */
export function hashStateBlock(fields: StateBlockFields): Uint8Array {
  if (fields.balance < 0n || fields.balance > MAX_RAW) {
    throw new ClientError(`Nano balance out of range: ${fields.balance}`);
  }
  const message = new Uint8Array(32 * 5 + 16);
  message.set(STATE_BLOCK_PREAMBLE, 0);
  message.set(fields.account, 32);
  message.set(fields.previous, 64);
  message.set(fields.representative, 96);
  message.set(bigIntToBytes(fields.balance, 16), 128);
  message.set(fields.link, 144);
  return blake2b(message, { dkLen: 32 });
}

export function signNanoBlockHash(hash: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return nanoEd25519.sign(hash, privateKey);
}

/** A signed state block in the JSON form Nano node RPCs (`process`) accept. */
export interface NanoStateBlock {
  type: 'state';
  account: string;
  previous: string;
  representative: string;
  balance: string;
  link: string;
  link_as_account: string;
  signature: string;
  work: string;
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

async function nanoRpc(
  rpcUrl: string,
  request: Record<string, string>
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(NANO_RPC_TIMEOUT_MILLIS),
    });
  } catch (error) {
    throw new ClientError(`Nano RPC ${request.action} request failed: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new ClientError(`Nano RPC ${request.action} failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (typeof body.error === 'string') {
    throw new ClientError(`Nano RPC ${request.action} failed: ${body.error}`);
  }
  return body;
}

function rpcString(body: Record<string, unknown>, key: string, action: string): string {
  const value = body[key];
  if (typeof value !== 'string') {
    throw new ClientError(`Nano RPC ${action} returned no "${key}"`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export interface NanoSendInput {
  privateKey: Uint8Array;
  payTo: string;
  amountRaw: bigint;
  rpcUrl: string;
}

/**
 * Build and sign a state send block of `amountRaw` from the key's account to `payTo`.
 *
 * In Nano the amount sent is the drop in balance from the previous block, so a wrong
 * previous balance means a wrong amount. The RPC is not trusted for it: the frontier block
 * is fetched, its hash recomputed, and its signature checked against the account's own key
 * before its balance is used.
 */
export async function createNanoSend(
  input: NanoSendInput
): Promise<{ block: NanoStateBlock; hash: string }> {
  const { privateKey, payTo, amountRaw, rpcUrl } = input;
  if (amountRaw <= 0n) {
    throw new ClientError(`Nano payment amount must be positive, got ${amountRaw} raw`);
  }

  const publicKey = nanoPublicKeyFromPrivateKey(privateKey);
  const account = nanoAddressFromPublicKey(publicKey);
  const destination = publicKeyFromNanoAddress(payTo);

  const info = await nanoRpc(rpcUrl, { action: 'account_info', account });
  const frontierHex = rpcString(info, 'frontier', 'account_info');
  const frontier = hexToBytes(frontierHex, 32, 'frontier from account_info');

  const blockInfo = await nanoRpc(rpcUrl, {
    action: 'block_info',
    json_block: 'true',
    hash: toHex(frontier),
  });
  const contents = blockInfo.contents as Record<string, unknown> | undefined;
  if (!contents || contents.type !== 'state') {
    throw new ClientError(
      `Nano frontier ${toHex(frontier)} of ${account} is not a state block; make one transaction from another Nano wallet first`
    );
  }
  const balanceText = rpcString(contents, 'balance', 'block_info');
  if (!/^\d+$/.test(balanceText)) {
    throw new ClientError(`Nano RPC block_info returned an invalid balance: ${balanceText}`);
  }
  const previousBalance = BigInt(balanceText);
  const representative = publicKeyFromNanoAddress(
    rpcString(contents, 'representative', 'block_info')
  );
  // Hashed with this account's key: a block from any other account cannot match the frontier
  const frontierHash = hashStateBlock({
    account: publicKey,
    previous: hexToBytes(rpcString(contents, 'previous', 'block_info'), 32, 'previous'),
    representative,
    balance: previousBalance,
    link: hexToBytes(rpcString(contents, 'link', 'block_info'), 32, 'link'),
  });
  const frontierSignature = hexToBytes(
    rpcString(contents, 'signature', 'block_info'),
    64,
    'signature'
  );
  if (
    toHex(frontierHash) !== toHex(frontier) ||
    !nanoEd25519.verify(frontierSignature, frontierHash, publicKey)
  ) {
    // An epoch upgrade block is signed by the epoch signer, not the account, and lands here too.
    throw new ClientError(
      `Nano RPC returned a frontier block for ${account} that is not signed by this account; refusing to sign`
    );
  }

  if (previousBalance < amountRaw) {
    throw new ClientError(
      `Insufficient Nano balance in ${account}: ${previousBalance} raw, payment needs ${amountRaw} raw (receive pending funds first)`
    );
  }
  const balance = previousBalance - amountRaw;

  const hash = hashStateBlock({
    account: publicKey,
    previous: frontier,
    representative,
    balance,
    link: destination,
  });
  const signature = signNanoBlockHash(hash, privateKey);

  const workResult = await nanoRpc(rpcUrl, { action: 'work_generate', hash: toHex(frontier) });
  const work = rpcString(workResult, 'work', 'work_generate');
  if (!/^[0-9a-fA-F]{16}$/.test(work)) {
    throw new ClientError(`Nano RPC work_generate returned invalid work: ${work}`);
  }

  return {
    hash: toHex(hash),
    block: {
      type: 'state',
      account,
      previous: toHex(frontier),
      representative: nanoAddressFromPublicKey(representative),
      balance: balance.toString(),
      link: toHex(destination),
      link_as_account: nanoAddressFromPublicKey(destination),
      signature: toHex(signature),
      work: work.toLowerCase(),
    },
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** True when a Nano key is configured, i.e. `nano:mainnet` accepts can be paid. */
export function isNanoConfigured(): boolean {
  return Boolean(process.env.MCPC_X402_NANO_KEY);
}

export interface NanoConfig {
  privateKey: Uint8Array;
  rpcUrl: string;
  maxAmountRaw: bigint;
}

export function readNanoConfig(): NanoConfig {
  const key = process.env.MCPC_X402_NANO_KEY;
  if (!key) {
    throw new ClientError('Set MCPC_X402_NANO_KEY to pay on nano:mainnet.');
  }
  const rpcUrl = process.env.MCPC_X402_NANO_RPC;
  if (!rpcUrl) {
    throw new ClientError('Set MCPC_X402_NANO_RPC to the URL of a Nano node RPC.');
  }
  const maxRaw = process.env.MCPC_X402_NANO_MAX_RAW;
  if (!maxRaw || !/^\d+$/.test(maxRaw)) {
    throw new ClientError(
      'Refusing to sign a Nano payment without a spend cap: set MCPC_X402_NANO_MAX_RAW to the largest amount (in raw) one payment may send.'
    );
  }
  return {
    privateKey: hexToBytes(key, 32, 'MCPC_X402_NANO_KEY'),
    rpcUrl,
    maxAmountRaw: BigInt(maxRaw),
  };
}
