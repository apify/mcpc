/**
 * Unit tests for the agent skill printed by `mcpc help --skill`.
 *
 * Doubles as a guard: `readGuide()` resolves the shipped guide relative to the
 * module and throws if it is missing, so these tests fail loudly if
 * `skills/mcpc/SKILL.md` goes missing or the relative path breaks. That the file
 * is actually included in the published npm tarball is verified by
 * packaging.test.ts.
 */

import { readGuide, printGuide } from '../../src/cli/commands/help.js';

describe('agent skill', () => {
  it('reads the guide markdown with frontmatter and key sections', () => {
    const md = readGuide();
    expect(md).toContain('name: mcpc');
    expect(md).toContain('## Mental model');
  });

  it('prints the guide to stdout', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printGuide();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toContain('## Mental model');
    } finally {
      spy.mockRestore();
    }
  });

  it('throws a helpful error when the guide file is missing', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        readFileSync: () => {
          throw new Error('ENOENT: no such file or directory');
        },
      };
    });
    try {
      const { readGuide: readGuideMocked } = await import('../../src/cli/commands/help.js');
      // Re-imported module has its own ClientError identity, so assert on the message.
      expect(() => readGuideMocked()).toThrow(/Agent guide not found[\s\S]*reinstall/);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});
