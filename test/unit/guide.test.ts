/**
 * Unit tests for the `mcpc guide` command.
 *
 * Doubles as a guard: `guideDir()` resolves the shipped guide relative to the
 * module, so these tests fail loudly if `skills/mcpc/SKILL.md` goes missing or
 * the relative path breaks (e.g. someone adds a `files` allowlist that drops
 * `skills/`). The published-tarball layout is verified separately via packing.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { guideDir, printGuide } from '../../src/cli/commands/guide.js';

function captureStdout(fn: () => void): string {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    fn();
    return spy.mock.calls.map((args) => args.join(' ')).join('\n');
  } finally {
    spy.mockRestore();
  }
}

describe('guide', () => {
  it('ships SKILL.md in the resolved guide directory', () => {
    const skillPath = join(guideDir(), 'SKILL.md');
    expect(existsSync(skillPath)).toBe(true);
    expect(readFileSync(skillPath, 'utf8')).toContain('name: mcpc');
  });

  it('prints the guide markdown with frontmatter and key sections', () => {
    const out = captureStdout(() => printGuide({ outputMode: 'human' }));
    expect(out).toContain('name: mcpc');
    expect(out).toContain('## Mental model');
    expect(out).toContain('mcpc guide --full');
  });

  it('appends the full reference when provided', () => {
    const marker = 'FULL-REFERENCE-MARKER';
    const out = captureStdout(() =>
      printGuide({ outputMode: 'human', fullReference: `# ref\n${marker}` })
    );
    expect(out).toContain('## Mental model');
    expect(out).toContain(marker);
    expect(out.indexOf(marker)).toBeGreaterThan(out.indexOf('## Mental model'));
  });

  it('wraps content as JSON in --json mode', () => {
    const out = captureStdout(() => printGuide({ outputMode: 'json' }));
    const parsed = JSON.parse(out) as { name: string; content: string };
    expect(parsed.name).toBe('mcpc');
    expect(parsed.content).toContain('## Mental model');
  });

  it('--raw prints raw markdown even in --json mode', () => {
    const out = captureStdout(() => printGuide({ outputMode: 'json', raw: true }));
    expect(() => JSON.parse(out)).toThrow();
    expect(out).toContain('name: mcpc');
  });

  it('truncates human output to --max-chars (but not raw)', () => {
    const truncated = captureStdout(() => printGuide({ outputMode: 'human', maxChars: 50 }));
    expect(truncated).toContain('output truncated');

    const raw = captureStdout(() => printGuide({ outputMode: 'human', raw: true, maxChars: 50 }));
    expect(raw).not.toContain('output truncated');
  });
});
