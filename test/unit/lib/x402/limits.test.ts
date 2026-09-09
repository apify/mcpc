/**
 * Unit tests for the x402 local spend limit helpers (`--x402-max-amount`).
 */

import { ClientError } from '../../../../src/lib/errors.js';
import {
  MIN_AMOUNT_USD,
  formatUsdAmount,
  parseMaxAmountUsd,
  usdToAtomicUnits,
} from '../../../../src/lib/x402/limits.js';

describe('usdToAtomicUnits', () => {
  it('converts dollars to 6-decimal atomic units', () => {
    expect(usdToAtomicUnits(1)).toBe(1_000_000n);
    expect(usdToAtomicUnits(0.5)).toBe(500_000n);
    expect(usdToAtomicUnits(MIN_AMOUNT_USD)).toBe(1n);
  });

  it('rounds binary-float amounts to the nearest atomic unit', () => {
    // 0.07 * 1e6 is 70000.00000000001 in IEEE 754 — must not truncate to 69999
    expect(usdToAtomicUnits(0.07)).toBe(70_000n);
    expect(usdToAtomicUnits(0.29)).toBe(290_000n);
  });
});

describe('formatUsdAmount', () => {
  it('keeps cents but drops trailing noise', () => {
    expect(formatUsdAmount(500_000n)).toBe('$0.50');
    expect(formatUsdAmount(1_000_000n)).toBe('$1.00');
    expect(formatUsdAmount(1_234_500n)).toBe('$1.2345');
  });

  it('keeps sub-cent amounts readable', () => {
    expect(formatUsdAmount(125n)).toBe('$0.000125');
    expect(formatUsdAmount(1n)).toBe('$0.000001');
  });
});

describe('parseMaxAmountUsd', () => {
  it('accepts positive dollar amounts', () => {
    expect(parseMaxAmountUsd('0.50')).toBe(0.5);
    expect(parseMaxAmountUsd('2')).toBe(2);
    expect(parseMaxAmountUsd(' 1.25 ')).toBe(1.25);
  });

  it.each(['', '0', '-1', 'abc', '1.0abc', 'Infinity', '0.0000001'])(
    'rejects %o',
    (value: string) => {
      expect(() => parseMaxAmountUsd(value)).toThrow(ClientError);
      expect(() => parseMaxAmountUsd(value)).toThrow('--x402-max-amount');
    }
  );
});
