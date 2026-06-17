/**
 * The baked-in agent usage guide, printed by `mcpc help --full`.
 *
 * The guide ships with the package (skills/mcpc/SKILL.md) and is read at
 * runtime so its content always matches the installed mcpc version.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ClientError } from '../../lib/errors.js';

/**
 * Directory holding the shipped guide content (`skills/mcpc`). This module
 * resolves to `<pkg>/dist/cli/commands/guide.js` once built (and
 * `<pkg>/src/cli/commands/guide.ts` in dev) — both sit three levels below the
 * package root, so the same relative path works either way.
 */
export function guideDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills', 'mcpc');
}

/** Read the shipped guide Markdown. Throws a ClientError if it is missing. */
export function readGuide(): string {
  const path = join(guideDir(), 'SKILL.md');
  try {
    return readFileSync(path, 'utf8').trimEnd();
  } catch (error) {
    throw new ClientError(
      `Agent guide not found at ${path}: ${(error as Error).message}. ` +
        `The mcpc install may be incomplete — reinstall it.`
    );
  }
}

/** `mcpc help --full` — print the agent usage guide as Markdown. */
export function printGuide(): void {
  console.log(readGuide());
}
