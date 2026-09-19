/**
 * Call-scoped override of the session's x402 spend limit (`tools-call --x402-max-amount`).
 *
 * The bridge runs one tool call inside `runWithPaymentLimit()`; the payment paths read the
 * scope back when they are about to sign, and fall back to the session limit when it is empty.
 *
 * `AsyncLocalStorage` rather than a field on the bridge: a limit set for one call is read much
 * later and asynchronously — when a 402 comes back inside the fetch middleware — and the bridge
 * serves concurrent tool calls (several CLI invocations, `--proxy`, async tasks). A shared field
 * would hand one call's limit to another. (The `--timeout` override next to it can use a plain
 * field precisely because the client reads it synchronously as the request starts.)
 *
 * Kept out of `limits.ts` so that module stays a pure value helper, and separate from any
 * viem-backed code so the CLI can import it without loading the bundled crypto.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const paymentLimitScope = new AsyncLocalStorage<bigint>();

/**
 * Run `fn` with `maxAmountAtomicUnits` as the spend limit for every payment it signs,
 * replacing the session limit (it may be higher or lower).
 */
export function runWithPaymentLimit<T>(
  maxAmountAtomicUnits: bigint,
  fn: () => Promise<T>
): Promise<T> {
  return paymentLimitScope.run(maxAmountAtomicUnits, fn);
}

/** The limit set for the tool call in progress, or undefined outside such a call. */
export function getScopedPaymentLimit(): bigint | undefined {
  return paymentLimitScope.getStore();
}
