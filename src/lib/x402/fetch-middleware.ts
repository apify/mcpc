/**
 * x402 fetch middleware for MCP transport
 *
 * Wraps the fetch function used by StreamableHTTPClientTransport to:
 * 1. Reuse a cached payment signature across calls to paid tools within a session
 * 2. Sign a fresh payment on the first call (or after cache invalidation)
 * 3. Handle HTTP 402 responses by parsing PAYMENT-REQUIRED, signing, and retrying once
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
 * captures it and `withSettlementReceipt()` re-attaches it under the MCP key, giving code
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
  selectAcceptEntry,
  DEFAULT_PAYMENT_EXPIRY_SECONDS,
  type SignerWallet,
  type PaymentRequiredAccept,
  type PaymentRequiredHeader,
  type SchemePreference,
} from './signer.js';
import { createLogger } from '../logger.js';

const logger = createLogger('x402-middleware');

/** MCP _meta key for x402 payment (per x402 MCP spec) */
const MCP_PAYMENT_META_KEY = 'x402/payment';

/** MCP _meta key for the x402 settlement receipt (per x402 MCP spec) */
export const MCP_PAYMENT_RESPONSE_META_KEY = 'x402/payment-response';

/**
 * Maximum size of a PAYMENT-RESPONSE header we will decode, in base64 characters.
 * A settlement receipt is a handful of hashes and addresses; anything near this cap is
 * a server bug or an attempt to bloat every tool result, and is dropped rather than parsed.
 */
const MAX_SETTLEMENT_RECEIPT_BASE64_CHARS = 64 * 1024;

/**
 * Unconsumed receipts kept per tool before the oldest is dropped. Only grows when
 * nothing consumes them (a direct middleware user with no bridge attaching them).
 */
const MAX_PENDING_RECEIPTS_PER_TOOL = 8;

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

/**
 * Shared mutable cache for payment signatures between the fetch middleware and the bridge.
 * The middleware reads and writes cached signatures; the bridge invalidates on JSON-RPC 402.
 */
export interface X402PaymentCache {
  /** Base64-encoded payment signature, or null if not yet signed / invalidated */
  signature: string | null;

  /**
   * Names of tools the server has charged for at runtime, via a payment-required tool
   * result or an HTTP 402. Challenge-first servers omit `_meta.x402` from `tools/list`,
   * so this is the only record that such a tool is paid at all — without it the cached
   * signature would have to be attached to every tools/call in the session (including
   * free ones) for the retry after a challenge to carry payment.
   */
  paymentRequiredTools?: Set<string>;

  /**
   * Settlement receipts decoded from the HTTP `PAYMENT-RESPONSE` header, queued per tool
   * name until `withSettlementReceipt()` attaches them to the matching tool result.
   *
   * Queued rather than a single slot because the header arrives with the HTTP response
   * headers, which on a streamed response precede the JSON-RPC result the bridge is
   * awaiting. Correlation is by tool name in FIFO order: two *concurrent* calls to the
   * same paid tool can therefore swap receipts — both are genuine receipts from this
   * session for that tool, and pinning them tighter would mean sending an mcpc-specific
   * correlation id to the server on every call.
   */
  settlements?: Map<string, SettlementReceipt[]>;
}

/**
 * An x402 `SettlementResponse`, kept exactly as the server encoded it.
 *
 * The spec's fields are `success`, `transaction`, `network` and the optional `errorReason`,
 * `payer`, `amount` and `extensions` — but mcpc neither validates nor normalizes them, so
 * that what a caller reconciles against is the server's receipt and not our reading of it.
 */
export type SettlementReceipt = Record<string, unknown>;

/**
 * Remember that the server charges for a tool, so later calls to it reuse the session's
 * payment signature even when the tool advertises no `_meta.x402`.
 */
export function recordPaymentRequiredTool(cache: X402PaymentCache, toolName: string): void {
  (cache.paymentRequiredTools ??= new Set<string>()).add(toolName);
}

/**
 * Decode a base64 `PAYMENT-RESPONSE` header into a settlement receipt.
 *
 * Fails open on everything: a server that omits the header, sends something that is not
 * base64 JSON, or sends a JSON value that is not an object gets no receipt and no error.
 * The payment already succeeded at this point — a malformed receipt must never turn a
 * paid-for tool result into a failure.
 */
function decodeSettlementReceipt(encodedBase64: string): SettlementReceipt | undefined {
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
    return parsed as SettlementReceipt;
  } catch (error) {
    logger.debug('Ignoring PAYMENT-RESPONSE header: not base64-encoded JSON:', error);
    return undefined;
  }
}

/**
 * Capture the settlement receipt from a paid response, if the server sent one.
 *
 * Called only for requests this middleware attached a payment to, so a receipt is never
 * queued against a call that did not pay for anything.
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

  const queue = (cache.settlements ??= new Map<string, SettlementReceipt[]>()).get(toolName) ?? [];
  queue.push(receipt);
  while (queue.length > MAX_PENDING_RECEIPTS_PER_TOOL) {
    queue.shift();
  }
  cache.settlements.set(toolName, queue);
  logger.debug(`Captured x402 settlement receipt for tool "${toolName}"`);
}

/**
 * Attach the settlement receipt captured for `toolName`, if any, to a tool result.
 *
 * Returns a copy of the result with the receipt at `_meta["x402/payment-response"]`, the
 * key the x402 MCP transport defines for it. A receipt the server already delivered
 * through that channel wins — mcpc never overwrites what the server itself reported. The
 * receipt is consumed either way, so it cannot leak onto a later call to the same tool.
 */
export function withSettlementReceipt<T>(result: T, cache: X402PaymentCache, toolName: string): T {
  const queue = cache.settlements?.get(toolName);
  const receipt = queue?.shift();
  if (queue && queue.length === 0) {
    cache.settlements?.delete(toolName);
  }
  if (!receipt || !result || typeof result !== 'object') {
    return result;
  }

  const meta = (result as { _meta?: Record<string, unknown> })._meta;
  if (meta && MCP_PAYMENT_RESPONSE_META_KEY in meta) {
    logger.debug(`Tool "${toolName}" reported its own settlement receipt, keeping it verbatim`);
    return result;
  }

  return {
    ...result,
    _meta: { ...meta, [MCP_PAYMENT_RESPONSE_META_KEY]: receipt },
  };
}

/**
 * Options for creating the x402 fetch middleware
 */
export interface X402FetchMiddlewareOptions {
  /** The wallet to sign payments with */
  wallet: SignerWallet;

  /**
   * Callback to look up a tool by name to check _meta.x402.
   * Returns the tool if found, undefined otherwise.
   * This is called per tools/call request for proactive signing.
   */
  getToolByName?: (name: string) => Tool | undefined;

  /** Shared mutable cache for reusing payment signatures across tool calls */
  paymentCache: X402PaymentCache;

  /** Payment scheme preference when multiple accepts are available (default: auto) */
  schemePreference?: SchemePreference;
}

/**
 * Create a fetch middleware that handles x402 payments.
 *
 * Returns a FetchLike function that wraps the original fetch:
 * - For tools/call POST requests: proactively sign if tool has _meta.x402
 * - For any request returning 402: parse, sign, retry once
 * - All other requests: pass through unchanged
 */
export function createX402FetchMiddleware(
  baseFetch: FetchLike,
  options: X402FetchMiddlewareOptions
): FetchLike {
  const { wallet, getToolByName, paymentCache, schemePreference } = options;

  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    // Try to get a payment signature (cached or freshly signed) for tools/call requests
    const paymentSignature = await getOrSignPayment(
      init,
      wallet,
      getToolByName,
      paymentCache,
      schemePreference
    );
    if (paymentSignature) {
      const enhancedInit = injectPayment(init, paymentSignature);
      const response = await baseFetch(url, enhancedInit);

      // If payment succeeded (not HTTP 402), return immediately
      if (response.status !== 402) {
        captureSettlementReceipt(paymentCache, init, response);
        return response;
      }

      // HTTP 402 — invalidate cache and fall through to fallback
      logger.debug('Payment rejected (HTTP 402), invalidating cache');
      paymentCache.signature = null;
      return handle402Fallback(
        url,
        init,
        response,
        baseFetch,
        wallet,
        paymentCache,
        schemePreference
      );
    }

    // No payment needed — make request normally
    const response = await baseFetch(url, init);

    // Check for HTTP 402 fallback
    if (response.status === 402) {
      return handle402Fallback(
        url,
        init,
        response,
        baseFetch,
        wallet,
        paymentCache,
        schemePreference
      );
    }

    return response;
  };
}

/**
 * Get a cached payment signature or sign a fresh one for a tools/call request.
 * Returns the base64-encoded PAYMENT-SIGNATURE, or undefined if the request
 * is not a tools/call for a payment-required tool.
 */
async function getOrSignPayment(
  init: RequestInit | undefined,
  wallet: SignerWallet,
  getToolByName: ((name: string) => Tool | undefined) | undefined,
  paymentCache: X402PaymentCache,
  schemePreference?: SchemePreference
): Promise<string | undefined> {
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

  // Only tools the server charges for get a payment. The signature is deliberately reused
  // across calls (servers such as mcp.apify.com treat it as a prepaid token, see #247), so
  // this check is what keeps it off free tools — the alternative, attaching it to every
  // tools/call, would hand a live authorization to calls that never asked for one.
  const advertisesPayment = !!x402?.paymentRequired;
  const chargedBefore = paymentCache.paymentRequiredTools?.has(toolName) ?? false;
  if (!advertisesPayment && !chargedBefore) {
    return undefined;
  }

  // Reuse the session's signature. The bridge stores one here after a payment-required
  // CallToolResult, and the retry must find it even though the tool has no _meta.x402.
  if (paymentCache.signature) {
    logger.debug(`Using cached payment signature for tool "${toolName}"`);
    return paymentCache.signature;
  }

  // Charged before, but the tool advertises no terms to sign from — defer to the challenge,
  // which carries the authoritative ones (a payment-required result handled by the bridge,
  // or an HTTP 402). Proactive signing still requires _meta.x402.
  if (!x402 || !x402.paymentRequired) {
    return undefined;
  }

  const accept = selectAcceptFromToolMeta(x402, schemePreference);
  if (!accept) {
    logger.debug(
      `Tool "${toolName}" _meta.x402 does not advertise a usable accept for schemePreference=${schemePreference ?? 'auto'}, deferring to 402 fallback`
    );
    return undefined;
  }

  try {
    const result = await signPayment({ wallet, accept });
    logger.debug(
      `Fresh payment signed: scheme=${accept.scheme} amount=$${result.amountUsd.toFixed(6)} to=${result.to} network=${result.networkLabel}`
    );
    paymentCache.signature = result.paymentSignatureBase64;
    return result.paymentSignatureBase64;
  } catch (error) {
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
  wallet: SignerWallet,
  paymentCache: X402PaymentCache,
  schemePreference?: SchemePreference
): Promise<Response> {
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
    logger.warn('Failed to parse PAYMENT-REQUIRED header:', error);
    return response402;
  }

  // Sign the payment
  try {
    const result = await signPayment({
      wallet,
      accept,
      resource: header.resource,
    });

    logger.debug(
      `402 fallback payment signed: scheme=${accept.scheme} amount=$${result.amountUsd.toFixed(6)} to=${result.to} network=${result.networkLabel}`
    );

    // Cache the freshly signed payment for subsequent calls
    paymentCache.signature = result.paymentSignatureBase64;

    // A 402 on a tools/call proves the server charges for that tool, even if it advertises
    // no _meta.x402, so later calls to it can reuse this signature
    const toolName = extractToolCallName(originalInit?.body);
    if (toolName) {
      recordPaymentRequiredTool(paymentCache, toolName);
    }

    // Retry with payment signature (once only)
    const retryInit = injectPayment(originalInit, result.paymentSignatureBase64);
    const retryResponse = await baseFetch(url, retryInit);
    captureSettlementReceipt(paymentCache, originalInit, retryResponse);
    return retryResponse;
  } catch (error) {
    logger.warn('402 fallback signing failed:', error);
    return response402;
  }
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
 * only when the preference matches the flat scheme (or the preference is `auto`).
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
