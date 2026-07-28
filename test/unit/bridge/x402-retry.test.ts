import { buildX402RetryMeta } from '../../../src/bridge/x402-retry.js';

describe('buildX402RetryMeta', () => {
  it('attaches the decoded payment payload to the immediate retry', () => {
    const paymentPayload = {
      x402Version: 2,
      payload: { authorization: { nonce: '0x1234' } },
    };

    expect(buildX402RetryMeta(undefined, paymentPayload)).toEqual({
      'x402/payment': paymentPayload,
    });
  });

  it('preserves caller metadata while replacing any stale payment', () => {
    const paymentPayload = {
      x402Version: 2,
      payload: { authorization: { nonce: '0xfresh' } },
    };

    expect(
      buildX402RetryMeta(
        {
          progressToken: 'progress-1',
          'x402/payment': { payload: { authorization: { nonce: '0xstale' } } },
        },
        paymentPayload
      )
    ).toEqual({
      progressToken: 'progress-1',
      'x402/payment': paymentPayload,
    });
  });
});
