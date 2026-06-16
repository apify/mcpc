/**
 * `mcpc guide` — print the baked-in agent usage guide.
 *
 * The guide ships with the package (skills/mcpc/SKILL.md) and is read at
 * runtime so its content always matches the installed mcpc version. `--full`
 * appends the complete command reference; the caller generates that from the
 * live Commander programs (single source of truth) and passes it in, so this
 * module stays free of any dependency on command registration.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { CommandOptions } from '../../lib/types.js';
import { ClientError } from '../../lib/errors.js';
import { formatJson, truncateOutput } from '../output.js';

/**
 * Directory holding the shipped guide content (`skills/mcpc`). This module
 * resolves to `<pkg>/dist/cli/commands/guide.js` once built (and
 * `<pkg>/src/cli/commands/guide.ts` in dev) — both sit three levels below the
 * package root, so the same relative path works either way.
 */
export function guideDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills', 'mcpc');
}

function readGuide(): string {
  const path = join(guideDir(), 'SKILL.md');
  try {
    return readFileSync(path, 'utf8').trimEnd();
  } catch {
    throw new ClientError(
      `mcpc guide content not found at ${path}. The mcpc install may be incomplete — reinstall it.`
    );
  }
}

export interface GuideOptions extends CommandOptions {
  /** Append the full command reference, generated and supplied by the caller. */
  fullReference?: string;
  /** Print only the raw markdown — no JSON wrapping, no truncation. */
  raw?: boolean;
}

/**
 * `mcpc guide` — print the usage guide. With `fullReference`, appends the full
 * command reference. Honors `--json` (wraps as `{ name, content }`), `--raw`
 * (markdown only), and `--max-chars` (human mode only).
 */
export function printGuide(options: GuideOptions): void {
  let content = readGuide();
  if (options.fullReference) {
    content = `${content}\n\n${options.fullReference.trimEnd()}`;
  }

  if (options.outputMode === 'json' && !options.raw) {
    console.log(formatJson({ name: 'mcpc', content }));
    return;
  }

  if (!options.raw && options.maxChars) {
    content = truncateOutput(content, options.maxChars);
  }
  console.log(content);
}
