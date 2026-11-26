/**
 * Spending limits for x402 auto-payment.
 *
 * Every amount an x402 server asks for is server-controlled, so a session that pays
 * automatically needs bounds it enforces itself: a cap on any single payment and a budget
 * for everything the session signs. Both are set at `mcpc connect` and kept in
 * `sessions.json`, so they hold across restarts.
 *
 * Kept free of the bundled viem code: the CLI imports this to validate flags and to render
 * limits without loading any crypto.
 */

import { ClientError } from '../errors.js';
import type { X402Limits } from '../types.js';

/** Largest single payment a session signs unless `--x402-max-payment` says otherwise. */
export const DEFAULT_X402_MAX_PAYMENT_USD = 1;

/** Total a session signs unless `--x402-budget` says otherwise. */
export const DEFAULT_X402_BUDGET_USD = 10;

/** USDC has 6 decimals; all x402 amounts mcpc signs are USDC atomic units. */
const USDC_DECIMALS = 6;
const ATOMIC_UNITS_PER_USD = 10 ** USDC_DECIMALS;

/**
 * A payment mcpc declined to sign as a matter of policy: over a limit, in a token other
 * than USDC, or needing an approval the user has not given. Unlike a signing failure
 * (RPC down, malformed challenge) it is always reported to the caller, who is the only
 * one able to lift the limit.
 */
export class PaymentRefusedError extends ClientError {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentRefusedError';
  }
}

export function usdToAtomicUnits(usd: number): bigint {
  return BigInt(Math.round(usd * ATOMIC_UNITS_PER_USD));
}

export function atomicUnitsToUsd(atomicUnits: bigint): number {
  return Number(atomicUnits) / ATOMIC_UNITS_PER_USD;
}

/** `$1.00`, `$0.005`: at least cents, and never rounding a small amount to zero. */
export function formatUsd(atomicUnits: bigint): string {
  const whole = atomicUnits / BigInt(ATOMIC_UNITS_PER_USD);
  const fraction = (atomicUnits % BigInt(ATOMIC_UNITS_PER_USD))
    .toString()
    .padStart(USDC_DECIMALS, '0')
    .replace(/0+$/, '')
    .padEnd(2, '0');
  return `$${whole.toString()}.${fraction}`;
}

/**
 * Parse an amount a server put in a payment requirement (USDC atomic units, a decimal
 * string). Anything else — a float, a negative number, hex — is refused rather than
 * guessed at.
 */
export function parseAtomicAmount(amount: unknown): bigint {
  if (typeof amount !== 'string' || !/^\d{1,30}$/.test(amount)) {
    throw new PaymentRefusedError(
      `x402 payment refused: the server sent an invalid amount (${JSON.stringify(amount)}).`
    );
  }
  return BigInt(amount);
}

/** Validate the value of `--x402-max-payment` / `--x402-budget` (USD, up to 6 decimals). */
export function parseUsdOption(value: string, flag: string): number {
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(value) || Number(value) <= 0) {
    throw new ClientError(
      `Invalid ${flag} value: "${value}". Expected a positive amount in USD, for example ${flag} 0.5`
    );
  }
  return Number(value);
}

/** Fill in the defaults for whatever the session record does not carry. */
export function resolveX402Limits(limits?: Partial<X402Limits>): X402Limits {
  const valid = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;
  return {
    maxPaymentUsd: valid(limits?.maxPaymentUsd)
      ? limits.maxPaymentUsd
      : DEFAULT_X402_MAX_PAYMENT_USD,
    budgetUsd: valid(limits?.budgetUsd) ? limits.budgetUsd : DEFAULT_X402_BUDGET_USD,
  };
}

/**
 * Enforces a session's limits and keeps its running total.
 *
 * The total counts what was *signed*, not what was settled: a signed authorization can be
 * redeemed in full until it expires whatever the server reports afterwards, so the worst
 * case is the only number mcpc can vouch for. A signature reused across calls counts once.
 */
export class X402SpendTracker {
  private readonly maxPaymentAtomicUnits: bigint;
  private readonly budgetAtomicUnits: bigint;
  private spentAtomicUnits: bigint;

  /**
   * @param raiseHint - How to lift a limit, appended to refusals (the bridge knows the
   *   session's name and server; this module does not)
   */
  constructor(
    readonly limits: X402Limits,
    spentUsd = 0,
    private readonly raiseHint?: (flag: string) => string
  ) {
    this.maxPaymentAtomicUnits = usdToAtomicUnits(limits.maxPaymentUsd);
    this.budgetAtomicUnits = usdToAtomicUnits(limits.budgetUsd);
    this.spentAtomicUnits = usdToAtomicUnits(
      Number.isFinite(spentUsd) && spentUsd > 0 ? spentUsd : 0
    );
  }

  get spentUsd(): number {
    return atomicUnitsToUsd(this.spentAtomicUnits);
  }

  /**
   * Count a payment against the limits before it is signed, or refuse it. Synchronous,
   * so two concurrent calls cannot both take the last of the budget.
   */
  reserve(amountAtomicUnits: bigint): void {
    if (amountAtomicUnits > this.maxPaymentAtomicUnits) {
      throw new PaymentRefusedError(
        `x402 payment refused: the server asks for ${formatUsd(amountAtomicUnits)}, above this ` +
          `session's limit of ${formatUsd(this.maxPaymentAtomicUnits)} per payment.` +
          this.hint('--x402-max-payment')
      );
    }
    if (this.spentAtomicUnits + amountAtomicUnits > this.budgetAtomicUnits) {
      throw new PaymentRefusedError(
        `x402 payment refused: the server asks for ${formatUsd(amountAtomicUnits)}, but this ` +
          `session has already authorized ${formatUsd(this.spentAtomicUnits)} of its ` +
          `${formatUsd(this.budgetAtomicUnits)} budget.` +
          this.hint('--x402-budget')
      );
    }
    this.spentAtomicUnits += amountAtomicUnits;
  }

  /** Give back a reservation whose payment was never signed, so never sent. */
  release(amountAtomicUnits: bigint): void {
    this.spentAtomicUnits -= amountAtomicUnits;
    if (this.spentAtomicUnits < 0n) this.spentAtomicUnits = 0n;
  }

  private hint(flag: string): string {
    return this.raiseHint ? `\n${this.raiseHint(flag)}` : '';
  }
}
