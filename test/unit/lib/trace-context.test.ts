/**
 * Unit tests for the environment-variable trace context carrier (TRACEPARENT and friends).
 */

import { readTraceContextFromEnv, sanitizeTraceContext } from '../../../src/lib/trace-context.js';

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

describe('readTraceContextFromEnv', () => {
  it('returns nothing without TRACEPARENT', () => {
    expect(readTraceContextFromEnv({})).toBeUndefined();
    expect(readTraceContextFromEnv({ TRACESTATE: 'a=b', BAGGAGE: 'k=v' })).toBeUndefined();
  });

  it('reads a well-formed TRACEPARENT alone', () => {
    expect(readTraceContextFromEnv({ TRACEPARENT: TRACEPARENT })).toEqual({
      traceparent: TRACEPARENT,
    });
  });

  it('carries TRACESTATE and BAGGAGE along, trimmed', () => {
    expect(
      readTraceContextFromEnv({
        TRACEPARENT: ` ${TRACEPARENT} `,
        TRACESTATE: ' vendor=abc ',
        BAGGAGE: 'userId=alice,region=eu',
      })
    ).toEqual({
      traceparent: TRACEPARENT,
      tracestate: 'vendor=abc',
      baggage: 'userId=alice,region=eu',
    });
  });

  it('rejects a malformed TRACEPARENT', () => {
    for (const bad of [
      '',
      '   ',
      'not-a-traceparent',
      '00-0AF7651916CD43DD8448EB211C80319C-B7AD6B7169203331-01', // uppercase hex
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b716920333-01', // short parent id
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331', // missing flags
    ]) {
      expect(readTraceContextFromEnv({ TRACEPARENT: bad, TRACESTATE: 'a=b' })).toBeUndefined();
    }
  });

  it('drops an oversized TRACESTATE or BAGGAGE but keeps the trace', () => {
    const huge = 'k=' + 'v'.repeat(9000);
    expect(readTraceContextFromEnv({ TRACEPARENT, TRACESTATE: huge, BAGGAGE: huge })).toEqual({
      traceparent: TRACEPARENT,
    });
  });
});

describe('sanitizeTraceContext', () => {
  it('accepts a carrier that arrived as JSON', () => {
    expect(
      sanitizeTraceContext({ traceparent: TRACEPARENT, tracestate: 'a=b', baggage: 'k=v' })
    ).toEqual({ traceparent: TRACEPARENT, tracestate: 'a=b', baggage: 'k=v' });
  });

  it('ignores anything that is not a well-formed carrier', () => {
    expect(sanitizeTraceContext(undefined)).toBeUndefined();
    expect(sanitizeTraceContext(null)).toBeUndefined();
    expect(sanitizeTraceContext('00-...')).toBeUndefined();
    expect(sanitizeTraceContext({ traceparent: 42 })).toBeUndefined();
    expect(sanitizeTraceContext({ traceparent: 'nope' })).toBeUndefined();
    // Non-string companions are dropped, the trace itself is kept
    expect(sanitizeTraceContext({ traceparent: TRACEPARENT, tracestate: ['a'] })).toEqual({
      traceparent: TRACEPARENT,
    });
  });
});
