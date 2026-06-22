/**
 * The baked-in agent skill, printed by `mcpc help --skill`.
 *
 * The guide ships with the package (skills/mcpc/SKILL.md) and is read at
 * runtime so its content always matches the installed mcpc version.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ClientError } from '../../lib/errors.js';

/**
 * Directory holding the shipped guide content (`skills/mcpc`). This module lives
 * in `<pkg>/dist/cli/commands/` once built (and `<pkg>/src/cli/commands/` in
 * dev) — both are three directories deep, so `../../../skills/mcpc` resolves to
 * the package root's `skills/mcpc` either way.
 */
function guideDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills', 'mcpc');
}

/** Read the shipped guide Markdown. Throws a ClientError if it is missing. */
export function readGuide(): string {
  const path = join(guideDir(), 'SKILL.md');
  try {
    // Trim so printGuide()'s console.log yields exactly one trailing newline.
    return readFileSync(path, 'utf8').trimEnd();
  } catch (error) {
    throw new ClientError(
      `Agent guide not found at ${path}: ${(error as Error).message}. ` +
        `The mcpc install may be incomplete — reinstall it.`
    );
  }
}

/** `mcpc help --skill` — print the agent skill as Markdown. */
export function printGuide(): void {
  console.log(readGuide());
}
