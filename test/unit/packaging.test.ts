/**
 * Guard for what the published npm package actually contains.
 *
 * `mcpc help --full` reads skills/mcpc/SKILL.md from the installed tree at runtime,
 * so that file MUST ship in the tarball — otherwise every `npx`/global install of
 * `mcpc help --full` throws at runtime while in-repo tests stay green. The file ships
 * today only because there is no `files` allowlist and `.npmignore` omits
 * `skills/`; this test fails loudly if that ever changes.
 *
 * Uses `npm pack --dry-run --json` (npm's documented file-listing interface,
 * pure Node, no external `tar`) rather than pnpm — this is package inspection,
 * not dependency management.
 */

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

interface PackResult {
  files: { path: string }[];
}

function packedPaths(): string[] {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const parsed = JSON.parse(out) as PackResult[];
  return parsed[0]?.files.map((f) => f.path) ?? [];
}

describe('published package contents', () => {
  it('includes the guide and bin so a fresh install can run `mcpc help --full`', () => {
    const paths = packedPaths();
    expect(paths).toContain('skills/mcpc/SKILL.md');
    expect(paths).toContain('bin/mcpc');
    expect(paths).toContain('dist/cli/commands/guide.js');
  }, 60_000);
});
