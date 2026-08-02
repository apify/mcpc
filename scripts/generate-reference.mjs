#!/usr/bin/env node
/**
 * Generates docs/REFERENCE.md — the `--help` output of every mcpc command, in the order
 * the commands appear in `mcpc --help`.
 *
 * The CLI's help text is mcpc's primary documentation surface (see CLAUDE.md), so the
 * reference is never hand-written: it is captured from the built CLI itself, exactly
 * like the Usage block in README.md is. Run it with `--check` to fail when the
 * committed file has drifted from the CLI.
 *
 * Usage:
 *   node scripts/generate-reference.mjs          Write docs/REFERENCE.md
 *   node scripts/generate-reference.mjs --check  Verify docs/REFERENCE.md is up to date
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(PROJECT_ROOT, 'bin', 'mcpc');
const OUTPUT_FILE = join(PROJECT_ROOT, 'docs', 'REFERENCE.md');

/**
 * Placeholder session name used for the session command help screens. The CLI accepts it
 * and echoes it back in usage lines and examples, which keeps the reference generic
 * instead of pinning it to whatever session happened to exist when it was generated.
 */
const SESSION = '@<session>';

const checkOnly = process.argv.includes('--check');

/**
 * Run the local CLI and return its stdout.
 *
 * The environment is scrubbed so the output depends only on the code: colors off (ANSI
 * escapes would end up in the Markdown), MCPC_* unset (they change output mode), and
 * MCPC_HOME_DIR pointed at a throwaway directory so no real session or profile data can
 * leak into the generated file.
 */
function runCli(args, homeDir) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MCPC_HOME_DIR: homeDir,
      MCPC_JSON: '',
      MCPC_VERBOSE: '',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
  });
}

/**
 * Collect the command names from a Commander `Commands:` block. Commander indents each
 * command term by exactly two spaces and wraps long descriptions further to the right,
 * so the two-space test picks the terms and skips continuation lines.
 */
function parseCommandsBlock(help) {
  const names = [];
  let inBlock = false;
  for (const line of help.split('\n')) {
    if (/^Commands:/.test(line)) {
      inBlock = true;
      continue;
    }
    if (/^\S/.test(line)) {
      inBlock = false;
      continue;
    }
    if (!inBlock) continue;
    const match = line.match(/^ {2}(\S+)/);
    if (match) names.push(match[1]);
  }
  return names;
}

/**
 * Collect the session command names from the "MCP session commands" block of the
 * top-level help — this is the order the task asks the reference to follow. Lines
 * without a command after the `<@session>` placeholder (the bare session screen) and
 * argument placeholders are skipped.
 */
function parseSessionCommandsBlock(help) {
  const names = [];
  let inBlock = false;
  for (const line of help.split('\n')) {
    if (/^MCP session commands/.test(line)) {
      inBlock = true;
      continue;
    }
    if (/^\S/.test(line)) {
      inBlock = false;
      continue;
    }
    if (!inBlock) continue;
    const match = line.match(/^ {2}<@session>\s+([a-z][a-z-]*)\b/);
    if (match) names.push(match[1]);
  }
  return names;
}

/**
 * Order `all` by `preferred`, keeping the entries `preferred` does not mention.
 *
 * The top-level help's session block is hand-maintained prose, so it defines the order
 * but cannot be trusted for completeness — the session program's own command list can.
 * Anything missing from `preferred` is placed next to the neighbour it has in `all`, so a
 * newly added session command shows up in the reference in a sensible spot even if nobody
 * remembered to list it in the overview.
 */
function orderBy(preferred, all) {
  const known = new Set(all);
  const result = preferred.filter((name) => known.has(name));
  for (const [index, name] of all.entries()) {
    if (result.includes(name)) continue;
    const successor = all.slice(index + 1).find((other) => result.includes(other));
    const at = successor ? result.indexOf(successor) : result.length;
    result.splice(at, 0, name);
  }
  return result;
}

/** GitHub's heading slug rules, enough for the headings this file generates. */
function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\w\- ]/g, '')
    .trim()
    .replace(/ +/g, '-');
}

/** One reference section: a heading, the anchor for the table of contents, and the help. */
function section(level, title, help) {
  return {
    level,
    title,
    anchor: slug(title),
    body: `${'#'.repeat(level)} \`${title}\`\n\n\`\`\`text\n${help.trimEnd()}\n\`\`\`\n`,
  };
}

function build() {
  const homeDir = mkdtempSync(join(tmpdir(), 'mcpc-reference-'));
  try {
    // The top-level help is the spine of the whole file: it defines which commands exist
    // and in which order they are documented.
    //
    // The "Full docs:" line is dropped for the same reason README.md drops it: it embeds
    // the current package version, which would make the committed file go stale on every
    // release and turn the --check gate into noise.
    const topLevelHelp = runCli(['--help'], homeDir);
    const topLevelCommands = parseCommandsBlock(topLevelHelp);
    if (topLevelCommands.length === 0) {
      throw new Error('no commands found in "mcpc --help" output');
    }

    const sections = [
      section(2, 'mcpc', topLevelHelp.replace(/^Full docs:.*\n?/m, '')),
    ];

    for (const command of topLevelCommands) {
      const help = runCli(['help', command], homeDir);
      sections.push(section(2, `mcpc ${command}`, help));

      // Commands with their own Commander program (x402) document their subcommands on
      // separate screens, which the parent screen only summarises.
      for (const subcommand of parseCommandsBlock(help)) {
        if (subcommand === 'help') continue;
        sections.push(
          section(3, `mcpc ${command} ${subcommand}`, runCli(['help', command, subcommand], homeDir))
        );
      }
    }

    const sessionHelp = runCli([SESSION, '--help'], homeDir);
    sections.push(section(2, `mcpc ${SESSION}`, sessionHelp));

    const sessionCommands = orderBy(
      parseSessionCommandsBlock(topLevelHelp),
      parseCommandsBlock(sessionHelp)
    );
    if (sessionCommands.length === 0) {
      throw new Error(`no commands found in "mcpc ${SESSION} --help" output`);
    }
    for (const command of sessionCommands) {
      sections.push(
        section(3, `mcpc ${SESSION} ${command}`, runCli([SESSION, command, '--help'], homeDir))
      );
    }

    const toc = sections
      .slice(1)
      .map((s) => `${'  '.repeat(s.level - 2)}- [\`${s.title}\`](#${s.anchor})`)
      .join('\n');

    return `<!-- AUTO-GENERATED FILE, DO NOT EDIT. Run \`pnpm run build:reference\` to regenerate. -->

# mcpc command reference

Complete \`--help\` output for every \`mcpc\` command, in the order the commands are listed
by \`mcpc --help\`. It is generated from the CLI itself, so it always matches the installed
version — run \`mcpc help <command>\` to get the same text in your terminal.

New to mcpc? Start with the [README](../README.md), or run \`mcpc help --skill\` for the agent guide.

${toc}

${sections.map((s) => s.body).join('\n')}`;
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
}

if (!existsSync(join(PROJECT_ROOT, 'dist', 'cli', 'index.js'))) {
  console.error('ERROR: dist/cli/index.js not found — run "pnpm run build" first.');
  process.exit(1);
}

const generated = build();

if (checkOnly) {
  const current = existsSync(OUTPUT_FILE) ? readFileSync(OUTPUT_FILE, 'utf8') : '';
  if (current !== generated) {
    console.error(
      'ERROR: docs/REFERENCE.md is out of date with the CLI help output.\n' +
        '       Run "pnpm run build:reference" and commit the result.'
    );
    process.exit(1);
  }
  console.log('docs/REFERENCE.md is up to date.');
} else {
  writeFileSync(OUTPUT_FILE, generated);
  console.log(`docs/REFERENCE.md updated (${generated.split('\n').length} lines).`);
}
