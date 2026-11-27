/**
 * Unit tests for the x402 session budget
 */

import { ClientError } from '../../../../src/lib/errors.js';
import {
  X402Budget,
  X402BudgetError,
  formatUsdc,
  parseX402BudgetUsd,
  usdToAtomic,
} from '../../../../src/lib/x402/budget.js';

const PAYEE = '0x000000000000000000000000000000000000dEaD';

function makeBudget(limitUsd: number, authorizedAtomic = 0n) {
  const persisted: bigint[] = [];
  const budget = new X402Budget({
    sessionName: '@paid',
    limitAtomic: usdToAtomic(limitUsd),
    authorizedAtomic,
    persist: (total) => {
      persisted.push(total);
      return Promise.resolve();
    },
  });
  return { budget, persisted };
}

describe('parseX402BudgetUsd', () => {
  it('accepts whole and fractional dollar amounts', () => {
    expect(parseX402BudgetUsd('2')).toBe(2);
    expect(parseX402BudgetUsd('0.50')).toBe(0.5);
    expect(parseX402BudgetUsd('0.000001')).toBe(0.000001);
  });

  it.each(['0', '-1', 'abc', '', '1e3', '$5', '1.2345678', '0x10', ' 5', '10000000'])(
    'rejects %j',
    (value) => {
      expect(() => parseX402BudgetUsd(value)).toThrow(ClientError);
    }
  );
});

describe('formatUsdc', () => {
  it('shows cents always and further digits only when present', () => {
    expect(formatUsdc(0n)).toBe('$0.00');
    expect(formatUsdc(3_000_000n)).toBe('$3.00');
    expect(formatUsdc(1_500_000n)).toBe('$1.50');
    expect(formatUsdc(1_234n)).toBe('$0.001234');
    expect(formatUsdc(1_000_000_000_000n)).toBe('$1000000.00');
  });
});

describe('X402Budget', () => {
  it('charges a payment that fits and records the new total before returning', async () => {
    const { budget, persisted } = makeBudget(5);

    const result = await budget.authorize(3_000_000n, PAYEE, () => Promise.resolve('signed'));

    expect(result).toBe('signed');
    expect(persisted).toEqual([3_000_000n]);
    expect(budget.remainingAtomic).toBe(2_000_000n);
  });

  it('refuses a payment over what is left, without signing', async () => {
    const { budget, persisted } = makeBudget(5, 3_000_000n);
    const sign = vi.fn(() => Promise.resolve('signed'));

    await expect(budget.authorize(3_000_000n, PAYEE, sign)).rejects.toThrow(X402BudgetError);

    expect(sign).not.toHaveBeenCalled();
    expect(persisted).toEqual([]);
    expect(budget.remainingAtomic).toBe(2_000_000n);
  });

  it('names the amounts and the way to raise the budget in the error', async () => {
    const { budget } = makeBudget(5, 3_000_000n);

    await expect(
      budget.authorize(3_000_000n, PAYEE, () => Promise.resolve('signed'))
    ).rejects.toThrow(/\$3\.00 .* \$2\.00 left of its \$5\.00 budget.*--x402-budget/);
  });

  it('allows a payment of exactly what is left', async () => {
    const { budget } = makeBudget(5, 3_000_000n);

    await budget.authorize(2_000_000n, PAYEE, () => Promise.resolve('signed'));

    expect(budget.remainingAtomic).toBe(0n);
  });

  it('starts with what earlier bridges of the session already authorized', async () => {
    const { budget } = makeBudget(5, 5_000_000n);

    await expect(budget.authorize(1n, PAYEE, () => Promise.resolve('signed'))).rejects.toThrow(
      X402BudgetError
    );
  });

  it('does not charge a payment whose signing failed', async () => {
    const { budget, persisted } = makeBudget(5);

    await expect(
      budget.authorize(3_000_000n, PAYEE, () => Promise.reject(new Error('signing failed')))
    ).rejects.toThrow('signing failed');

    expect(persisted).toEqual([]);
    expect(budget.remainingAtomic).toBe(5_000_000n);
  });

  it('does not hand out a signature it could not record', async () => {
    const budget = new X402Budget({
      sessionName: '@paid',
      limitAtomic: usdToAtomic(5),
      authorizedAtomic: 0n,
      persist: () => Promise.reject(new Error('disk full')),
    });

    await expect(
      budget.authorize(1_000_000n, PAYEE, () => Promise.resolve('signed'))
    ).rejects.toThrow('disk full');
  });

  // Two tool calls arriving together must not both see the same remaining budget.
  it('runs concurrent authorizations one at a time', async () => {
    const { budget } = makeBudget(5);
    const slowSign = (): Promise<string> =>
      new Promise((resolve) => setTimeout(() => resolve('signed'), 10));

    const results = await Promise.allSettled([
      budget.authorize(3_000_000n, PAYEE, slowSign),
      budget.authorize(3_000_000n, PAYEE, slowSign),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(budget.remainingAtomic).toBe(2_000_000n);
  });

  it('keeps working after a refused payment', async () => {
    const { budget } = makeBudget(5);

    await expect(
      budget.authorize(9_000_000n, PAYEE, () => Promise.resolve('signed'))
    ).rejects.toThrow(X402BudgetError);
    await expect(
      budget.authorize(1_000_000n, PAYEE, () => Promise.resolve('signed'))
    ).resolves.toBe('signed');
  });
});
