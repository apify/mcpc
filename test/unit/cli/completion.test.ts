/**
 * Tests for the completion-complete argument mapping
 */

import { buildCompleteParams } from '../../../src/cli/commands/completion.js';
import { ClientError } from '../../../src/lib/errors.js';

describe('buildCompleteParams', () => {
  it('completes the last argument and sends the earlier ones as context', () => {
    expect(
      buildCompleteParams('prompt', 'code_review', { language: 'python', framework: 'fla' })
    ).toEqual({
      ref: { type: 'ref/prompt', name: 'code_review' },
      argument: { name: 'framework', value: 'fla' },
      context: { arguments: { language: 'python' } },
    });
  });

  it('maps a resource template reference and keeps an empty typed value', () => {
    expect(buildCompleteParams('resource', 'file:///{path}', { path: '' })).toEqual({
      ref: { type: 'ref/resource', uri: 'file:///{path}' },
      argument: { name: 'path', value: '' },
    });
  });

  it('omits context when only one argument was given', () => {
    expect(buildCompleteParams('prompt', 'p', { a: 'x' })).not.toHaveProperty('context');
  });

  it('rejects an empty argument list with the last-argument rule', () => {
    expect(() => buildCompleteParams('prompt', 'code_review', {})).toThrow(ClientError);
    expect(() => buildCompleteParams('prompt', 'code_review', {})).toThrow(
      /the last one is completed/
    );
  });

  it('rejects an unknown reference type with both accepted words', () => {
    expect(() => buildCompleteParams('tool', 'x', { a: '' })).toThrow(ClientError);
    expect(() => buildCompleteParams('tool', 'x', { a: '' })).toThrow(/"prompt".*"resource"/s);
  });
});
