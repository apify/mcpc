/**
 * Guards for documentation that is generated from the code or from README.md and
 * committed to the repository:
 *
 * - docs/images/related-work.svg is rendered from the "MCP CLI clients" comparison
 *   table in README.md ("Related work" section) by scripts/generate-related-work-image.mjs.
 * - docs/REFERENCE.md is captured from `mcpc --help` and `mcpc help <command>` by
 *   scripts/generate-reference.mjs (runs the built CLI, so `pnpm run build` must have
 *   completed — the same requirement test/unit/packaging.test.ts already has).
 *
 * Both scripts have a `--check` mode that exits non-zero when the committed file has
 * drifted from its source. These tests run that mode so a stale file fails the unit
 * tests, the same way test/unit/cli/readme-help.test.ts guards the Usage block in
 * README.md.
 */

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function expectUpToDate(script: string): void {
  const result = spawnSync(process.execPath, [join(PROJECT_ROOT, script), '--check'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  expect(result.status, output).toBe(0);
}

describe('generated documentation', () => {
  it('docs/images/related-work.svg matches the README table (run "node scripts/generate-related-work-image.mjs" to fix)', () => {
    expectUpToDate('scripts/generate-related-work-image.mjs');
  });

  it('docs/REFERENCE.md matches the CLI help (run "pnpm run build:reference" to fix)', () => {
    expectUpToDate('scripts/generate-reference.mjs');
  }, 60_000);
});
