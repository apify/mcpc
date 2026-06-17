/**
 * Unit tests for the agent guide printed by `mcpc help --full`.
 *
 * Doubles as a guard: `readGuide()` resolves the shipped guide relative to the
 * module and throws if it is missing, so these tests fail loudly if
 * `skills/mcpc/SKILL.md` goes missing or the relative path breaks. That the file
 * is actually included in the published npm tarball is verified by
 * packaging.test.ts.
 */

import { readGuide, printGuide } from '../../src/cli/commands/guide.js';

describe('agent guide', () => {
  it('reads the guide markdown with frontmatter and key sections', () => {
    const md = readGuide();
    expect(md).toContain('name: mcpc');
    expect(md).toContain('## Mental model');
  });

  it('prints the guide to stdout', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printGuide();
      const out = spy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(out).toContain('## Mental model');
    } finally {
      spy.mockRestore();
    }
  });
});
