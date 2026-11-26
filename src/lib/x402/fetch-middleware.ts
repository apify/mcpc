/**
 * x402 fetch middleware for MCP transport
 *
 * Wraps the fetch function used by StreamableHTTPClientTransport to:
 * 1. Reuse a cached payment signature across calls that ask for the same payment terms
 * 2. Sign a fresh payment on the first call (or after cache invalidation)
 * 3. Handle HTTP 402 responses by parsing PAYMENT-REQUIRED, signing, and retrying once
 *
 * Every amount, payee and token here is chosen by the server, so nothing is signed before
 * the session's spending limits agree to it (`signSessionPayment`), and each signature is
 * reported back to the caller on the tool result it paid for.
 *
 * Payment is injected in two places simultaneously (server decides which to use):
 * - HTTP header: PAYMENT-SIGNATURE (base64-encoded payment payload)
 * - JSON-RPC body: params._meta["x402/payment"] (payment payload object)
 *
 * The settlement receipt comes back through the mirror image of those two channels:
 * - HTTP header: PAYMENT-RESPONSE (base64-encoded SettlementResponse)
 * - tool result: _meta["x402/payment-response"] (SettlementResponse object)
 *
 * The second one reaches the caller on its own (mcpc prints tool results verbatim), the
 * first is consumed by the transport and would otherwise be dropped. So this middleware
 * captures it and `withPaymentMeta()` re-attaches it under the MCP key, giving code
 * mode one place to look for the receipt whichever channel the server used.
 *
 * The cache is shared with the bridge layer, which invalidates it when the server
 * returns a payment-required tool result and signs a fresh payment before retrying.
 *
 * This middleware is injected into the transport via the SDK's `fetch` option.
 */

import type { FetchLike, Tool } from '@modelcontextprotocol/client';
import {
  signPayment,
  parsePaymentRequired,
  paymentTermsKey,
  selectAcceptEntry,
  isSupportedAsset,
  DEFAULT_PAYMENT_EXPIRY_SECONDS,
  type SignerWallet,
  type PaymentRequiredAccept,
  type PaymentRequiredHeader,
  type SchemePreference,
} from './signer.js';
import { createLogger } from '../logger.js';
import type { DetachedToolCall } from '../types.js';
import {
  PaymentRefusedError,
  atomicUnitsToUsd,
  formatUsd,
  parseAtomicAmount,
  type X402SpendTracker,
} from './limits.js';

const logger = createLogger('x402-middleware');

/** MCP _meta key for x402 payment (per x402 MCP spec) */
const MCP_PAYMENT_META_KEY = 'x402/payment';

/** MCP _meta key for the x402 settlement receipt (per x402 MCP spec) */
export const MCP_PAYMENT_RESPONSE_META_KEY = 'x402/payment-response';

/**
 * `_meta` key under which mcpc reports a payment it signed for a tool call. Not part of
 * x402: the protocol tells the caller what was settled (the receipt above), never what
 * the client authorized, and that is the number an agent's operator has to be able to see.
 */
export const MCPC_PAYMENT_META_KEY = 'com.apify.mcpc/x402-payment';

/** A cached signature is not reused this close to its expiry: the server could not settle it. */
const REUSE_EXPIRY_MARGIN_MILLIS = 30_000;

/**
 * Maximum size of a PAYMENT-RESPONSE header we will decode, in base64 characters.
 * A settlement receipt is a handful of hashes and addresses; anything near this cap is
 * a server bug or an attempt to bloat every tool result, and is dropped rather than parsed.
 */
const MAX_SETTLEMENT_RECEIPT_BASE64_CHARS = 64 * 1024;

/**
 * Payment information from tool's `_meta.x402`.
 *
 * Apify exposes two shapes side-by-side:
 * - **`accepts[]`** carries every advertised scheme (post apify-mcp-server #876).
 *   Walk this when present — it's the only way to honor the session's `--x402 <scheme>`
 *   preference against servers that advertise multiple schemes.
 * - **Flat preferred fields** mirror the server's preferred entry for back-compat
 *   with clients that don't iterate `accepts[]`. Used as a fallback.
 */
interface ToolPaymentMeta {
  paymentRequired: boolean;
  accepts?: PaymentRequiredAccept[];
  scheme?: string;
  network?: string;
  amount?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string; facilitatorAddress?: string };
}

/** Parsed JSON-RPC request body (enough to identify tools/call) */
interface JsonRpcRequest {
  method?: string;
  params?: {
    name?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** A payment mcpc signed, as reported at `_meta["com.apify.mcpc/x402-payment"]`. */
export interface X402PaymentRecord {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  /** Authorized amount in USDC atomic units (for `upto`, the cap) */
  amount: string;
  amountUsd: number;
  expiresAt: string;
}

/**
 * Shared mutable cache for payment signatures between the fetch middleware and the bridge.
 */
export interface X402PaymentCache {
  /**
   * Signed payments that can still be reused, keyed by the terms they were signed for
   * (`paymentTermsKey`). Reuse is deliberate — servers such as mcp.apify.com treat a
   * signature as a prepaid token (#247) — but only for a request asking for the very same
   * scheme, network, token, payee and amount, and only until the signature expires.
   */
  payments: Map<string, { signature: string; expiresAtMillis: number }>;

  /**
   * The terms the server last demanded for a tool at runtime, via a payment-required tool
   * result or an HTTP 402. Challenge-first servers omit `_meta.x402` from `tools/list`, so
   * this is the only record that such a tool is paid at all — without it the retry after a
   * challenge could not find its payment, and attaching one to every tools/call instead
   * would hand a live authorization to calls that never asked for one.
   */
  toolTerms: Map<string, string>;

  /**
   * The settlement receipt from the last paid response's `PAYMENT-RESPONSE` header, with
   * the tool it paid for, until `withPaymentMeta()` attaches it to that tool's
   * result. Kept exactly as the server encoded it: mcpc does not validate or normalize
   * the spec's `success`/`transaction`/`network` fields, so a caller reconciles against
   * the server's receipt rather than our reading of it.
   *
   * One slot, and the tool name is what keeps a paid tool's receipt off a free tool's
   * result. Concurrent paid calls are the one case it does not serve: the newer receipt
   * wins and the older is logged and dropped. Holding both would not fix it — correlating
   * a receipt to one of two in-flight calls to the *same* tool needs a per-call id on the
   * wire, which is not worth sending to every server for this.
   */
  lastSettlement?: { toolName: string; receipt: Record<string, unknown> };

  /**
   * The payment last signed for a tool call, until `withPaymentMeta()` attaches it to that
   * tool's result. Same single slot and same caveat as `lastSettlement`; every signature
   * is also written to the bridge log, so an overwritten one is not lost.
   */
  lastPayment?: { toolName: string; payment: X402PaymentRecord };
}

export function createPaymentCache(): X402PaymentCache {
  return { payments: new Map(), toolTerms: new Map() };
}

/** The cached signature for the given terms, unless it is missing or about to expire. */
function getReusablePayment(cache: X402PaymentCache, termsKey: string): string | undefined {
  const cached = cache.payments.get(termsKey);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAtMillis - REUSE_EXPIRY_MARGIN_MILLIS <= Date.now()) {
    cache.payments.delete(termsKey);
    return undefined;
  }
  return cached.signature;
}

/** What the middleware and the bridge need to sign a payment on the session's behalf. */
export interface X402PaymentContext {
  /** The wallet to sign payments with */
  wallet: SignerWallet;

  /** Shared mutable cache for reusing payment signatures across tool calls */
  paymentCache: X402PaymentCache;

  /** Payment scheme preference when multiple accepts are available (default: auto) */
  schemePreference?: SchemePreference;

  /** The session's spending limits; every signature is counted against them first */
  spend: X402SpendTracker;

  /** Called after each signature, before it is sent (the bridge persists the new total) */
  onPayment?: (payment: X402PaymentRecord, toolName: string | undefined) => void | Promise<void>;
}

/**
 * Sign a payment for the session: the one place a server's payment terms turn into a
 * signature. Refuses (`PaymentRefusedError`) before signing when the amount is over the
 * session's per-payment limit or its remaining budget; on success caches the signature
 * under its terms and records what was signed for the caller.
 *
 * @returns The base64-encoded PAYMENT-SIGNATURE value
 */
export async function signSessionPayment(
  context: X402PaymentContext,
  accept: PaymentRequiredAccept,
  options: { resource?: PaymentRequiredHeader['resource']; toolName?: string } = {}
): Promise<string> {
  const { paymentCache, spend } = context;
  const { toolName } = options;
  const amountAtomicUnits = parseAtomicAmount(accept.amount);

  // Throws when over a limit. Reserved before the first await, so concurrent calls cannot
  // both spend the last of the budget.
  spend.reserve(amountAtomicUnits);

  let signed;
  try {
    signed = await signPayment({
      wallet: context.wallet,
      accept,
      ...(options.resource && { resource: options.resource }),
    });
  } catch (error) {
    spend.release(amountAtomicUnits);
    throw error;
  }

  const termsKey = paymentTermsKey(accept);
  paymentCache.payments.set(termsKey, {
    signature: signed.paymentSignatureBase64,
    expiresAtMillis: signed.expiresAt.getTime(),
  });

  const payment: X402PaymentRecord = {
    scheme: accept.scheme,
    network: accept.network,
    asset: accept.asset,
    payTo: accept.payTo,
    amount: amountAtomicUnits.toString(),
    amountUsd: atomicUnitsToUsd(amountAtomicUnits),
    expiresAt: signed.expiresAt.toISOString(),
  };
  if (toolName) {
    paymentCache.toolTerms.set(toolName, termsKey);
    paymentCache.lastPayment = { toolName, payment };
  }

  // info, not debug: money moving must be visible in the bridge log without --verbose
  logger.info(
    `x402 payment signed: ${accept.scheme === 'upto' ? 'up to ' : ''}${formatUsd(amountAtomicUnits)} ` +
      `to ${accept.payTo} on ${signed.networkLabel} for ${toolName ? `tool "${toolName}"` : 'a non-tool request'} ` +
      `(session total $${spend.spentUsd} of $${spend.limits.budgetUsd})`
  );
  await context.onPayment?.(payment, toolName);

  return signed.paymentSignatureBase64;
}

/**
 * Decode a base64 `PAYMENT-RESPONSE` header into a settlement receipt.
 *
 * Fails open on everything: a server that omits the header, sends something that is not
 * base64 JSON, or sends a JSON value that is not an object gets no receipt and no error.
 * The payment already succeeded at this point — a malformed receipt must never turn a
 * paid-for tool result into a failure.
 */
function decodeSettlementReceipt(encodedBase64: string): Record<string, unknown> | undefined {
  if (encodedBase64.length > MAX_SETTLEMENT_RECEIPT_BASE64_CHARS) {
    logger.warn(
      `Ignoring PAYMENT-RESPONSE header: ${encodedBase64.length} base64 chars exceeds the ${MAX_SETTLEMENT_RECEIPT_BASE64_CHARS} cap`
    );
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.from(encodedBase64, 'base64').toString('utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.debug('Ignoring PAYMENT-RESPONSE header: decoded value is not a JSON object');
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    logger.debug('Ignoring PAYMENT-RESPONSE header: not base64-encoded JSON:', error);
    return undefined;
  }
}

/**
 * Capture the settlement receipt from a paid response, if the server sent one.
 *
 * Called only for requests this middleware attached a payment to, so a receipt is never
 * recorded against a call that did not pay for anything.
 */
function captureSettlementReceipt(
  cache: X402PaymentCache,
  init: RequestInit | undefined,
  response: Response
): void {
  // Headers.get() is case-insensitive, so this matches any casing the server used
  const encoded = response.headers.get('PAYMENT-RESPONSE');
  if (!encoded) {
    return;
  }

  const receipt = decodeSettlementReceipt(encoded);
  if (!receipt) {
    return;
  }

  const toolName = extractToolCallName(init?.body);
  if (!toolName) {
    // A 402 on initialize or another non-tools/call request: there is no tool result to
    // carry the receipt, so log it and move on rather than mislabel it as some tool's.
    logger.debug('Received PAYMENT-RESPONSE on a non-tools/call request:', receipt);
    return;
  }

  if (cache.lastSettlement) {
    logger.debug(
      `Dropping an unclaimed settlement receipt for tool "${cache.lastSettlement.toolName}"`
    );
  }
  cache.lastSettlement = { toolName, receipt };
  logger.debug(`Captured x402 settlement receipt for tool "${toolName}"`);
}

/**
 * Attach what mcpc knows about the payment for a call to `toolName` to its tool result.
 *
 * Returns a copy of the result with, when there is one:
 * - the payment mcpc signed for this call at `_meta["com.apify.mcpc/x402-payment"]`
 *   (absent when a signature from an earlier call was reused — nothing new was authorized);
 * - the server's settlement receipt at `_meta["x402/payment-response"]`, the key the x402
 *   MCP transport defines for it. A receipt the server already delivered through that
 *   channel wins — mcpc never overwrites what the server itself reported.
 *
 * Both are consumed either way, so neither can leak onto a later call to the same tool.
 */
export function withPaymentMeta<T>(result: T, cache: X402PaymentCache, toolName: string): T {
  const additions: Record<string, unknown> = {};
  const meta =
    result && typeof result === 'object'
      ? (result as { _meta?: Record<string, unknown> })._meta
      : undefined;

  if (cache.lastPayment?.toolName === toolName) {
    additions[MCPC_PAYMENT_META_KEY] = cache.lastPayment.payment;
    delete cache.lastPayment;
  }

  if (cache.lastSettlement?.toolName === toolName) {
    const { receipt } = cache.lastSettlement;
    delete cache.lastSettlement;
    if (meta && MCP_PAYMENT_RESPONSE_META_KEY in meta) {
      logger.debug(`Tool "${toolName}" reported its own settlement receipt, keeping it verbatim`);
    } else {
      additions[MCP_PAYMENT_RESPONSE_META_KEY] = receipt;
    }
  }

  if (!result || typeof result !== 'object' || Object.keys(additions).length === 0) {
    return result;
  }
  return { ...result, _meta: { ...meta, ...additions } };
}

/**
 * {@link withPaymentMeta} for what a detached tool call (`tools-call --detach`)
 * produced: the payment details go on the tool result when the server answered with one,
 * and otherwise on the task it created in its place — the paid request is the one that
 * created the task. An absent outcome (the call failed) still consumes them, so they cannot
 * surface on the next call to the same tool.
 */
export function withPaymentMetaOnDetachedCall(
  outcome: DetachedToolCall | undefined,
  cache: X402PaymentCache,
  toolName: string
): DetachedToolCall | undefined {
  if (outcome?.result) {
    return { ...outcome, result: withPaymentMeta(outcome.result, cache, toolName) };
  }
  if (outcome?.task) {
    return { ...outcome, task: withPaymentMeta(outcome.task, cache, toolName) };
  }
  withPaymentMeta(outcome, cache, toolName);
  return outcome;
}

/**
 * Options for creating the x402 fetch middleware
 */
export interface X402FetchMiddlewareOptions extends X402PaymentContext {
  /**
   * Callback to look up a tool by name to check _meta.x402.
   * Returns the tool if found, undefined otherwise.
   * This is called per tools/call request for proactive signing.
   */
  getToolByName?: (name: string) => Tool | undefined;
}

/**
 * Create a fetch middleware that handles x402 payments.
 *
 * Returns a FetchLike function that wraps the original fetch:
 * - For tools/call POST requests: proactively sign if tool has _meta.x402
 * - For any request returning 402: parse, sign, retry once
 * - All other requests: pass through unchanged
 *
 * A payment mcpc will not make — over the session's limits, or on terms it does not sign
 * for — rejects the request with a `PaymentRefusedError` instead of passing the 402
 * through, so the caller learns why and which limit to raise.
 */
export function createX402FetchMiddleware(
  baseFetch: FetchLike,
  options: X402FetchMiddlewareOptions
): FetchLike {
  const { paymentCache } = options;

  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    // Try to get a payment signature (cached or freshly signed) for tools/call requests
    const payment = await getOrSignPayment(init, options);
    if (payment) {
      const enhancedInit = injectPayment(init, payment.signature);
      const response = await baseFetch(url, enhancedInit);

      // If payment succeeded (not HTTP 402), return immediately
      if (response.status !== 402) {
        captureSettlementReceipt(paymentCache, init, response);
        return response;
      }

      // HTTP 402 — the server turned this signature down, so never offer it again
      logger.debug('Payment rejected (HTTP 402), invalidating cache');
      paymentCache.payments.delete(payment.termsKey);
      return handle402Fallback(url, init, response, baseFetch, options);
    }

    // No payment needed — make request normally
    const response = await baseFetch(url, init);

    // Check for HTTP 402 fallback
    if (response.status === 402) {
      return handle402Fallback(url, init, response, baseFetch, options);
    }

    return response;
  };
}

/**
 * Get a cached payment signature or sign a fresh one for a tools/call request.
 * Returns the base64-encoded PAYMENT-SIGNATURE with the terms it was signed for, or
 * undefined if the request is not a tools/call for a payment-required tool.
 */
async function getOrSignPayment(
  init: RequestInit | undefined,
  options: X402FetchMiddlewareOptions
): Promise<{ signature: string; termsKey: string } | undefined> {
  const { getToolByName, paymentCache, schemePreference } = options;
  if (!init?.body) {
    return undefined;
  }

  // Only handle POST requests (tools/call is always POST)
  if (init.method && init.method.toUpperCase() !== 'POST') {
    return undefined;
  }

  // Parse the request body to find tools/call requests
  const toolName = extractToolCallName(init.body);
  if (!toolName) {
    return undefined;
  }

  // Look up tool metadata (absent on challenge-first servers, which advertise no price
  // until the tool is called)
  const tool = getToolByName?.(toolName);
  if (getToolByName && !tool) {
    logger.debug(`Tool "${toolName}" not found in cache, relying on runtime payment challenges`);
  }
  const x402 = (tool as { _meta?: { x402?: ToolPaymentMeta } } | undefined)?._meta?.x402;

  // Only tools the server charges for get a payment: ones that advertise a price, and ones
  // it has challenged before. That is what keeps a live authorization off free tools.
  const advertised = x402?.paymentRequired
    ? selectAcceptFromToolMeta(x402, schemePreference)
    : undefined;
  const challengedTermsKey = paymentCache.toolTerms.get(toolName);
  if (!x402?.paymentRequired && !challengedTermsKey) {
    return undefined;
  }

  // Reuse a signature made for the same terms. What the server demanded at runtime is
  // tried first: it is authoritative where it differs from the advertised price. The
  // bridge stores a signature here after a payment-required CallToolResult, and the retry
  // must find it even though the tool has no _meta.x402.
  const candidates = [challengedTermsKey, advertised && paymentTermsKey(advertised)];
  for (const termsKey of candidates) {
    const signature = termsKey && getReusablePayment(paymentCache, termsKey);
    if (termsKey && signature) {
      logger.debug(`Using cached payment signature for tool "${toolName}"`);
      return { signature, termsKey };
    }
  }

  // Charged before, but the tool advertises no terms to sign from — defer to the challenge,
  // which carries the authoritative ones (a payment-required result handled by the bridge,
  // or an HTTP 402). Proactive signing still requires _meta.x402.
  if (!advertised) {
    logger.debug(
      `Tool "${toolName}" advertises no usable accept for schemePreference=${schemePreference ?? 'auto'}, deferring to 402 fallback`
    );
    return undefined;
  }

  try {
    const signature = await signSessionPayment(options, advertised, { toolName });
    return { signature, termsKey: paymentTermsKey(advertised) };
  } catch (error) {
    if (error instanceof PaymentRefusedError) {
      throw error;
    }
    logger.warn(`Payment signing failed for tool "${toolName}":`, error);
    return undefined;
  }
}

/**
 * Handle a 402 response by parsing PAYMENT-REQUIRED, signing, and retrying once.
 * Also updates the payment cache with the freshly signed payment.
 */
async function handle402Fallback(
  url: string | URL,
  originalInit: RequestInit | undefined,
  response402: Response,
  baseFetch: FetchLike,
  options: X402FetchMiddlewareOptions
): Promise<Response> {
  const { paymentCache, schemePreference } = options;

  // Extract PAYMENT-REQUIRED header (case-insensitive)
  const paymentRequiredBase64 =
    response402.headers.get('PAYMENT-REQUIRED') || response402.headers.get('payment-required');

  if (!paymentRequiredBase64) {
    logger.debug('402 response has no PAYMENT-REQUIRED header, passing through');
    return response402;
  }

  logger.debug('Received 402 with PAYMENT-REQUIRED header, signing payment...');

  let header: PaymentRequiredHeader;
  let accept: PaymentRequiredAccept;
  try {
    ({ header, accept } = parsePaymentRequired(paymentRequiredBase64, schemePreference));
  } catch (error) {
    // Nothing in the challenge that mcpc would pay (another chain, another token, or not
    // a challenge at all). Say so: the bare 402 would tell the caller nothing.
    logger.warn('Failed to parse PAYMENT-REQUIRED header:', error);
    throw new PaymentRefusedError(`x402 payment refused: ${(error as Error).message}`);
  }

  // A 402 on a tools/call proves the server charges for that tool, even if it advertises
  // no _meta.x402, so later calls to it can reuse the signature for these terms
  const toolName = extractToolCallName(originalInit?.body);
  const termsKey = paymentTermsKey(accept);

  let signature: string;
  try {
    // A signature already held for exactly these terms (and not just turned down — that
    // one was dropped before getting here) pays for this request too.
    const cached = getReusablePayment(paymentCache, termsKey);
    if (cached && toolName) {
      paymentCache.toolTerms.set(toolName, termsKey);
    }
    signature =
      cached ??
      (await signSessionPayment(options, accept, {
        ...(header.resource && { resource: header.resource }),
        ...(toolName && { toolName }),
      }));
  } catch (error) {
    if (error instanceof PaymentRefusedError) {
      throw error;
    }
    logger.warn('402 fallback signing failed:', error);
    return response402;
  }

  // Retry with payment signature (once only)
  const retryInit = injectPayment(originalInit, signature);
  const retryResponse = await baseFetch(url, retryInit);
  if (retryResponse.status === 402) {
    paymentCache.payments.delete(termsKey);
  } else {
    captureSettlementReceipt(paymentCache, originalInit, retryResponse);
  }
  return retryResponse;
}

/**
 * Extract the tool name from a JSON-RPC tools/call request body.
 * Returns undefined if the body isn't a tools/call request.
 */
function extractToolCallName(body: RequestInit['body'] | undefined): string | undefined {
  if (!body || typeof body !== 'string') {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(body);

    // Handle single request
    if (!Array.isArray(parsed)) {
      const req = parsed as JsonRpcRequest;
      if (req.method === 'tools/call' && req.params?.name) {
        return req.params.name;
      }
      return undefined;
    }

    // Handle batch — find first tools/call
    for (const item of parsed) {
      const req = item as JsonRpcRequest;
      if (req.method === 'tools/call' && req.params?.name) {
        return req.params.name;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pick an accept entry from a tool's `_meta.x402` block honoring `schemePreference`.
 *
 * Prefers the spec-shaped `accepts[]` array when present; falls back to the flat fields
 * only when the preference matches the flat scheme (or the preference is `auto`) and the
 * flat network and token are ones mcpc signs for.
 * Returning undefined defers signing to the 402 fallback path, which re-runs the
 * selector against the authoritative PAYMENT-REQUIRED header.
 */
function selectAcceptFromToolMeta(
  x402: ToolPaymentMeta,
  schemePreference?: SchemePreference
): PaymentRequiredAccept | undefined {
  const preference = schemePreference ?? 'auto';

  if (Array.isArray(x402.accepts) && x402.accepts.length > 0) {
    return selectAcceptEntry(x402.accepts, preference);
  }

  if (!x402.scheme || !x402.network || !x402.amount || !x402.asset || !x402.payTo) {
    return undefined;
  }
  if (preference !== 'auto' && preference !== x402.scheme) {
    return undefined;
  }
  if (!isSupportedAsset(x402.network, x402.asset)) {
    return undefined;
  }

  return {
    scheme: x402.scheme,
    network: x402.network,
    amount: x402.amount,
    asset: x402.asset,
    payTo: x402.payTo,
    maxTimeoutSeconds: x402.maxTimeoutSeconds || DEFAULT_PAYMENT_EXPIRY_SECONDS,
    ...(x402.extra && { extra: x402.extra }),
  };
}

/**
 * Extract `PaymentRequiredAccept` from a PaymentRequired object honoring scheme preference.
 *
 * Expected shape: `{ x402Version, accepts: [...] }`. Default preference is `auto`
 * (prefer upto, fall back to exact) when the caller doesn't pin one.
 */
export function extractAcceptFromPaymentRequired(
  data: unknown,
  schemePreference?: SchemePreference
):
  | {
      accept: PaymentRequiredAccept;
      resource?: { url?: string; description?: string; mimeType?: string };
    }
  | undefined {
  if (!data || typeof data !== 'object') return undefined;

  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.accepts) || obj.accepts.length === 0) return undefined;

  const accept = selectAcceptEntry(
    obj.accepts as PaymentRequiredAccept[],
    schemePreference ?? 'auto'
  );
  if (!accept) {
    return undefined;
  }

  const resource = obj.resource as
    { url?: string; description?: string; mimeType?: string } | undefined;
  if (resource) {
    return { accept, resource };
  }
  return { accept };
}

/** Content item from MCP tool result */
interface ToolResultContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** Shape of an MCP tool call result */
interface ToolCallResult {
  content?: ToolResultContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Check if a tool call result is an x402 payment-required response.
 * Returns the PaymentRequired data if found, undefined otherwise.
 *
 * Per the x402 MCP transport spec, payment required is signaled as a tool result with:
 * - isError: true
 * - structuredContent containing { x402Version, accepts: [...] } (preferred)
 * - OR content[0].text as JSON-encoded PaymentRequired (fallback)
 */
export function extractPaymentRequiredFromResult(
  result: unknown
): Record<string, unknown> | undefined {
  if (!result || typeof result !== 'object') return undefined;

  const toolResult = result as ToolCallResult;
  if (!toolResult.isError) return undefined;

  // Path 1: structuredContent (preferred)
  if (toolResult.structuredContent && isPaymentRequired(toolResult.structuredContent)) {
    return toolResult.structuredContent;
  }

  // Path 2: content[0].text as JSON (fallback)
  const content = toolResult.content;
  if (!Array.isArray(content) || content.length === 0) return undefined;

  const first = content[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return undefined;

  try {
    const parsed: unknown = JSON.parse(first.text);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      isPaymentRequired(parsed as Record<string, unknown>)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON
  }

  return undefined;
}

/** Check if an object looks like a PaymentRequired (has x402Version + accepts array) */
function isPaymentRequired(obj: Record<string, unknown>): boolean {
  return 'x402Version' in obj && 'accepts' in obj && Array.isArray(obj.accepts);
}

/**
 * Inject payment into both the HTTP header and the JSON-RPC body _meta.
 * The same payment payload is used for both channels so the server can pick either.
 */
function injectPayment(init: RequestInit | undefined, paymentSignatureBase64: string): RequestInit {
  // 1. HTTP header (existing mechanism)
  const headers = new Headers(init?.headers);
  headers.set('PAYMENT-SIGNATURE', paymentSignatureBase64);

  const result: RequestInit = { ...init, headers };

  // 2. JSON-RPC body _meta (x402 MCP spec mechanism)
  if (init?.body && typeof init.body === 'string') {
    try {
      const paymentPayload = JSON.parse(
        Buffer.from(paymentSignatureBase64, 'base64').toString('utf-8')
      ) as Record<string, unknown>;
      result.body = injectPaymentMeta(init.body, paymentPayload);
    } catch (error) {
      logger.debug('Failed to inject payment into body _meta:', error);
      // Fall back to header-only — body injection is best-effort
    }
  }

  return result;
}

/**
 * Inject payment payload into the _meta field of a single tools/call JSON-RPC request.
 * Batch requests are left untouched (header-only) — a single payment cannot safely
 * apply to multiple tools/call entries that may have different pricing.
 */
function injectPaymentMeta(body: string, paymentPayload: Record<string, unknown>): string {
  try {
    const parsed: unknown = JSON.parse(body);

    // IMPORTANT: Skip batch requests. Injecting the same payment into every tools/call
    // entry in a batch is wrong — each tool may have different pricing, and one signed
    // payment cannot safely apply to multiple calls. Batches still get the HTTP header
    // (PAYMENT-SIGNATURE), which the server can use as a fallback.
    if (Array.isArray(parsed)) {
      return body;
    }

    const req = parsed as JsonRpcRequest;
    if (req.method === 'tools/call' && req.params) {
      return JSON.stringify({
        ...req,
        params: {
          ...req.params,
          _meta: {
            ...((req.params._meta as Record<string, unknown>) || {}),
            [MCP_PAYMENT_META_KEY]: paymentPayload,
          },
        },
      });
    }

    return body;
  } catch {
    return body;
  }
}
