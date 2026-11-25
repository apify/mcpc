/**
 * Unit tests for x402 spending limits
 */

import { ClientError } from '../../../../src/lib/errors.js';
import {
  DEFAULT_X402_BUDGET_USD,
  DEFAULT_X402_MAX_PAYMENT_USD,
  PaymentRefusedError,
  X402SpendTracker,
  formatUsd,
  parseAtomicAmount,
  parseUsdOption,
  resolveX402Limits,
} from '../../../../src/lib/x402/limits.js';

describe('parseUsdOption', () => {
  it.each([
    ['1', 1],
    ['0.5', 0.5],
    ['12.345678', 12.345678],
    ['0.000001', 0.000001],
  ])('accepts %s', (value, expected) => {
    expect(parseUsdOption(value, '--x402-budget')).toBe(expected);
  });

  it.each(['0', '0.0', '-1', '1e3', 'abc', '', '1.2345678', '$5', '5 ', '.5', 'Infinity'])(
    'rejects %j',
    (value) => {
      expect(() => parseUsdOption(value, '--x402-budget')).toThrow(ClientError);
      expect(() => parseUsdOption(value, '--x402-budget')).toThrow('Invalid --x402-budget value');
    }
  );
});

describe('parseAtomicAmount', () => {
  it('parses a decimal string of atomic units', () => {
    expect(parseAtomicAmount('1000000')).toBe(1_000_000n);
    expect(parseAtomicAmount('0')).toBe(0n);
  });

  it.each(['1.5', '-1', '0x10', '1e6', '', ' 1', 1_000_000, null, undefined, '9'.repeat(31)])(
    'refuses %j',
    (amount) => {
      expect(() => parseAtomicAmount(amount)).toThrow(PaymentRefusedError);
    }
  );
});

describe('formatUsd', () => {
  it.each([
    [1_000_000n, '$1.00'],
    [10_000n, '$0.01'],
    [5_000n, '$0.005'],
    [1n, '$0.000001'],
    [2_500_000n, '$2.50'],
    [0n, '$0.00'],
    [123_456_789_000_000n, '$123456789.00'],
  ])('%s → %s', (atomicUnits, expected) => {
    expect(formatUsd(atomicUnits)).toBe(expected);
  });
});

describe('resolveX402Limits', () => {
  const defaults = {
    maxPaymentUsd: DEFAULT_X402_MAX_PAYMENT_USD,
    budgetUsd: DEFAULT_X402_BUDGET_USD,
  };

  it('uses the defaults for a session that stores no limits', () => {
    expect(resolveX402Limits()).toEqual(defaults);
    expect(resolveX402Limits({})).toEqual(defaults);
  });

  it('keeps the limits that are set', () => {
    expect(resolveX402Limits({ budgetUsd: 2 })).toEqual({ ...defaults, budgetUsd: 2 });
    expect(resolveX402Limits({ maxPaymentUsd: 0.1, budgetUsd: 0.2 })).toEqual({
      maxPaymentUsd: 0.1,
      budgetUsd: 0.2,
    });
  });

  it('does not let a corrupt record lift the limits', () => {
    const corrupt = { maxPaymentUsd: Infinity, budgetUsd: 'lots' } as never;
    expect(resolveX402Limits(corrupt)).toEqual(defaults);
    expect(resolveX402Limits({ maxPaymentUsd: -1, budgetUsd: NaN })).toEqual(defaults);
  });
});

describe('X402SpendTracker', () => {
  const limits = { maxPaymentUsd: 1, budgetUsd: 2.5 };

  it('allows a payment at the limit and refuses one above it', () => {
    const tracker = new X402SpendTracker(limits);
    tracker.reserve(1_000_000n);
    expect(() => tracker.reserve(1_000_001n)).toThrow(PaymentRefusedError);
    expect(tracker.spentUsd).toBe(1);
  });

  it('refuses the payment that would take the total past the budget', () => {
    const tracker = new X402SpendTracker(limits);
    tracker.reserve(1_000_000n);
    tracker.reserve(1_000_000n);
    expect(() => tracker.reserve(600_000n)).toThrow(
      'the server asks for $0.60, but this session has already authorized $2.00 of its $2.50 budget'
    );
    tracker.reserve(500_000n);
    expect(tracker.spentUsd).toBe(2.5);
    expect(() => tracker.reserve(1n)).toThrow(PaymentRefusedError);
  });

  it('starts from the total the session had before', () => {
    const tracker = new X402SpendTracker(limits, 2.4);
    expect(() => tracker.reserve(200_000n)).toThrow(PaymentRefusedError);
    tracker.reserve(100_000n);
    expect(tracker.spentUsd).toBe(2.5);
  });

  it('gives a reservation back', () => {
    const tracker = new X402SpendTracker(limits);
    tracker.reserve(1_000_000n);
    tracker.release(1_000_000n);
    expect(tracker.spentUsd).toBe(0);
  });

  it('says how to raise the limit that refused', () => {
    const tracker = new X402SpendTracker(
      limits,
      0,
      (flag) => `Run: mcpc connect s @s ${flag} <usd>`
    );
    expect(() => tracker.reserve(2_000_000n)).toThrow('--x402-max-payment <usd>');
    tracker.reserve(1_000_000n);
    tracker.reserve(1_000_000n);
    expect(() => tracker.reserve(1_000_000n)).toThrow('--x402-budget <usd>');
  });
});
