/**
 * x402 spending budget of a session
 *
 * A session with `--x402` signs payment authorizations whenever the server asks for one,
 * and the server names the amount. The budget is the one bound the server cannot move: the
 * total amount of USDC the session may authorize over its lifetime. Every authorization is
 * charged against it in full before it is handed to the server, and one that does not fit
 * is refused.
 *
 * It counts what was *authorized*, not what was settled: mcpc cannot observe settlement
 * (a receipt is the server's own word), and for the `upto` scheme an authorization is a cap
 * the server may draw on later. So the budget is a ceiling on what the session can lose,
 * and real spending is usually lower.
 *
 * Kept free of the bundled viem so the CLI can parse `--x402-budget` without loading it.
 */

import { ClientError } from '../errors.js';

/** USDC has 6 decimals: 1 USDC = 1_000_000 atomic units. */
const USDC_DECIMALS = 6;
const ATOMIC_PER_USDC = 10n ** BigInt(USDC_DECIMALS);

/** Budget of a session connected with `--x402` and no `--x402-budget`. */
export const DEFAULT_X402_BUDGET_USD = 10;

/** Upper bound for `--x402-budget`, to catch typos such as an amount in atomic units. */
const MAX_X402_BUDGET_USD = 1_000_000;

/** Convert a USD (USDC) amount to atomic units. */
export function usdToAtomic(usd: number): bigint {
  return BigInt(Math.round(usd * Number(ATOMIC_PER_USDC)));
}

/** Format atomic USDC units as dollars, e.g. `1500000n` → `$1.50`, `1234n` → `$0.001234`. */
export function formatUsdc(atomic: bigint): string {
  const whole = atomic / ATOMIC_PER_USDC;
  const fraction = (atomic % ATOMIC_PER_USDC).toString().padStart(USDC_DECIMALS, '0');
  // Keep cents always, further digits only when they are not zero
  const trimmed = fraction.replace(/0+$/, '');
  return `$${whole}.${trimmed.padEnd(2, '0')}`;
}

/**
 * Parse the value of `--x402-budget`: a positive amount in USD with at most 6 decimals.
 */
export function parseX402BudgetUsd(value: string): number {
  const usd = /^\d+(\.\d{1,6})?$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(usd) || usd <= 0 || usd > MAX_X402_BUDGET_USD) {
    throw new ClientError(
      `Invalid --x402-budget value: "${value}". Expected an amount in USD, e.g. 2 or 0.50.`
    );
  }
  return usd;
}

/**
 * A payment the session's budget does not cover. Unlike other signing failures, which fall
 * back to showing the server's payment request, this one is reported to the user as is: it
 * is the answer to "why was this not paid", and it says how to allow it.
 */
export class X402BudgetError extends ClientError {
  constructor(message: string) {
    super(message);
    this.name = 'X402BudgetError';
  }
}

export interface X402BudgetOptions {
  /** Session name, for the error message. */
  sessionName: string;
  /** Total the session may authorize, in atomic USDC units. */
  limitAtomic: bigint;
  /** What it has authorized so far (restored from `sessions.json` on a bridge restart). */
  authorizedAtomic: bigint;
  /**
   * Record the new total. Awaited before a signed payment is used, so an authorization
   * that could not be recorded is never sent.
   */
  persist: (authorizedAtomic: bigint) => Promise<void>;
}

export class X402Budget {
  private readonly sessionName: string;
  private readonly limitAtomic: bigint;
  private authorizedAtomic: bigint;
  private readonly persist: (authorizedAtomic: bigint) => Promise<void>;
  /** Tail of the queue that runs authorizations one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: X402BudgetOptions) {
    this.sessionName = options.sessionName;
    this.limitAtomic = options.limitAtomic;
    this.authorizedAtomic = options.authorizedAtomic;
    this.persist = options.persist;
  }

  get remainingAtomic(): bigint {
    const remaining = this.limitAtomic - this.authorizedAtomic;
    return remaining > 0n ? remaining : 0n;
  }

  /**
   * Sign a payment of `amountAtomic` if the budget covers it, and charge it.
   *
   * Authorizations run one at a time: two tool calls arriving together must not both see
   * the same remaining budget. The amount is charged only once `sign` succeeded.
   *
   * @throws X402BudgetError when the amount exceeds what is left
   */
  authorize<T>(amountAtomic: bigint, payee: string, sign: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      if (amountAtomic > this.remainingAtomic) {
        throw new X402BudgetError(
          `x402 payment of ${formatUsdc(amountAtomic)} to ${payee} not made: session ${this.sessionName} ` +
            `has ${formatUsdc(this.remainingAtomic)} left of its ${formatUsdc(this.limitAtomic)} budget. ` +
            `To raise it, run: mcpc ${this.sessionName} close, then connect again with ` +
            `--x402 --x402-budget <usd>`
        );
      }
      const signed = await sign();
      const total = this.authorizedAtomic + amountAtomic;
      await this.persist(total);
      this.authorizedAtomic = total;
      return signed;
    });
    // Keep the queue alive after a refused or failed authorization
    this.queue = run.catch(() => undefined);
    return run;
  }
}
