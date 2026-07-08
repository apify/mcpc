/**
 * Guard for what the published npm package actually contains.
 *
 * `mcpc help --skill` reads skills/mcpc/SKILL.md from the installed tree at runtime,
 * so that file MUST ship in the tarball — otherwise every `npx`/global install of
 * `mcpc help --skill` throws at runtime while in-repo tests stay green. The file ships
 * today only because there is no `files` allowlist and `.npmignore` omits
 * `skills/`; this test fails loudly if that ever changes.
 *
 * Uses `npm pack --dry-run --json` (npm's documented file-listing interface,
 * pure Node, no external `tar`) rather than pnpm — this is package inspection,
 * not dependency management.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

interface PackResult {
  files: { path: string }[];
}

function packedPaths(): string[] {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  // execSync (a shell command line) so Windows resolves the `npm.cmd` shim; args are
  // static literals, so no injection surface.
  const out = execSync('npm pack --dry-run --json', {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const parsed = JSON.parse(out) as PackResult[];
  return parsed[0]?.files.map((f) => f.path) ?? [];
}

describe('published package contents', () => {
  it('includes the guide and bin so a fresh install can run `mcpc help --skill`', () => {
    const paths = packedPaths();
    expect(paths).toContain('skills/mcpc/SKILL.md');
    expect(paths).toContain('bin/mcpc');
    expect(paths).toContain('dist/cli/commands/help.js');
    // The bundled viem boundary must ship — x402 resolves viem from it at runtime.
    expect(paths).toContain('dist/lib/x402/viem.js');
  }, 60_000);

  it('does not ship viem as a runtime dependency (it is bundled at build time)', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['viem']).toBeUndefined();
  });
});
