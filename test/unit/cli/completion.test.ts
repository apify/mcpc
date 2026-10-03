/**
 * Tests for the completion-complete argument mapping
 */

import { buildCompleteParams } from '../../../src/cli/commands/completion.js';
import { ClientError } from '../../../src/lib/errors.js';

describe('buildCompleteParams', () => {
  it('maps a prompt reference, the typed value and the remaining context', () => {
    expect(
      buildCompleteParams('prompt', 'code_review', 'framework', {
        language: 'python',
        framework: 'fla',
      })
    ).toEqual({
      ref: { type: 'ref/prompt', name: 'code_review' },
      argument: { name: 'framework', value: 'fla' },
      context: { arguments: { language: 'python' } },
    });
  });

  it('maps a resource template reference and defaults the value to empty', () => {
    expect(buildCompleteParams('resource', 'file:///{path}', 'path', {})).toEqual({
      ref: { type: 'ref/resource', uri: 'file:///{path}' },
      argument: { name: 'path', value: '' },
    });
  });

  it('omits context when only the completed argument was given', () => {
    const params = buildCompleteParams('prompt', 'p', 'a', { a: 'x' });
    expect(params).not.toHaveProperty('context');
    expect(params.argument).toEqual({ name: 'a', value: 'x' });
  });

  it('rejects an unknown reference type with both accepted words', () => {
    expect(() => buildCompleteParams('tool', 'x', 'a', {})).toThrow(ClientError);
    expect(() => buildCompleteParams('tool', 'x', 'a', {})).toThrow(/"prompt".*"resource"/s);
  });
});
