/**
 * Unit tests for the agent guide printed by `mcpc help --full`.
 *
 * Doubles as a guard: `guideDir()` resolves the shipped guide relative to the
 * module, so these tests fail loudly if `skills/mcpc/SKILL.md` goes missing or
 * the relative path breaks. That the file is actually included in the published
 * npm tarball is verified by packaging.test.ts.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { guideDir, readGuide, printGuide } from '../../src/cli/commands/guide.js';

describe('agent guide', () => {
  it('ships SKILL.md in the resolved guide directory', () => {
    const skillPath = join(guideDir(), 'SKILL.md');
    expect(existsSync(skillPath)).toBe(true);
    expect(readFileSync(skillPath, 'utf8')).toContain('name: mcpc');
  });

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
