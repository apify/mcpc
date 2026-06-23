/**
 * Verifies that the auto-generated help section in README.md matches
 * the actual output of `mcpc --help`. Run `npm run build:readme` to fix.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const PROJECT_ROOT = resolve(__dirname, '../../..');

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function getHelpOutput(): string {
  const output = execSync('npx tsx src/cli/index.ts --help', {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  // Same filtering as update-readme.sh: remove the self-referential "Full docs:" line (keep the agent-guide hint above it) and trailing empty lines
  return stripAnsi(output)
    .replace(/^Full docs:.*\n?/m, '')
    .trimEnd();
}

function getReadmeHelpBlock(): string {
  const readme = readFileSync(resolve(PROJECT_ROOT, 'README.md'), 'utf-8');
  const marker = '<!-- AUTO-GENERATED: mcpc --help -->';
  const markerIdx = readme.indexOf(marker);
  if (markerIdx === -1) {
    throw new Error(`Marker not found in README.md: ${marker}`);
  }

  // Find the code block after the marker
  const afterMarker = readme.slice(markerIdx + marker.length);
  const codeBlockMatch = afterMarker.match(/```\n([\s\S]*?)```/);
  if (!codeBlockMatch) {
    throw new Error('No code block found after the help marker in README.md');
  }

  return codeBlockMatch[1].trimEnd();
}

describe('README help section', () => {
  it('matches mcpc --help output (run "npm run build:readme" to fix)', () => {
    const helpOutput = getHelpOutput();
    const readmeBlock = getReadmeHelpBlock();
    expect(readmeBlock).toBe(helpOutput);
  });
});
