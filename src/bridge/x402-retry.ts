const MCP_PAYMENT_META_KEY = 'x402/payment';

/**
 * Preserve caller metadata and attach the decoded payment payload for the
 * immediate MCP retry.
 */
export function buildX402RetryMeta(
  requestMeta: Record<string, unknown> | undefined,
  paymentPayload: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...requestMeta,
    [MCP_PAYMENT_META_KEY]: paymentPayload,
  };
}
