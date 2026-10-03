#!/usr/bin/env node
/**
 * Builds the body of a GitHub release from CHANGELOG.md.
 *
 * GitHub renders the start of the release body into the social preview card shown
 * wherever a release URL is shared (Slack, X, LinkedIn…), so the body opens with a
 * one-line summary of the release instead of install instructions. The summary is
 * the plain-text paragraph written right under the version heading in CHANGELOG.md:
 *
 *   ## [Unreleased]
 *
 *   MCP Skills extension support, directory resources and safer OAuth refresh.
 *
 *   ### Added
 *   ...
 *
 * When a section has no such paragraph, a summary is derived from its entry counts
 * ("3 new features, 5 fixes and 1 security fix"). The changelog entries follow, then
 * install instructions and the install-size report. The release workflow passes the
 * result to softprops/action-gh-release, which appends GitHub's generated
 * "What's Changed" list of pull requests and contributors below it.
 *
 * Usage:
 *   node scripts/release-notes.mjs --version 0.7.0 [--section Unreleased] [--out notes.md]
 *
 * --section defaults to --version; pre-releases pass `Unreleased`, since their entries
 * have not been moved under a version heading. The install-size report is read from
 * the INSTALL_SIZE_REPORT environment variable (optional).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Changelog categories in Keep a Changelog order, with the nouns used in a derived summary. */
const CATEGORY_NOUNS = {
  Added: ['new feature', 'new features'],
  Changed: ['change', 'changes'],
  Deprecated: ['deprecation', 'deprecations'],
  Removed: ['removal', 'removals'],
  Fixed: ['fix', 'fixes'],
  Security: ['security fix', 'security fixes'],
};

/**
 * Returns the body of the `## [<name>]` section of a changelog (without the heading),
 * or null when there is no such section.
 */
export function extractSection(changelogText, name) {
  const lines = changelogText.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## [${name}]`));
  if (start === -1) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    // The next version heading or the trailing link reference definitions end the section.
    if (line.startsWith('## ') || /^\[[^\]]+\]:\s/.test(line)) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

/**
 * Splits a changelog section into its summary paragraph (the text before the first
 * `###` category heading, collapsed to one line) and the categorized entries.
 */
export function splitSummary(section) {
  const match = /^###\s/m.exec(section);
  const intro = match ? section.slice(0, match.index) : section;
  const entries = match ? section.slice(match.index).trim() : '';
  // Only plain text counts as a summary; a stray bullet list before the first category is an entry.
  const summary = /^\s*[-*]\s/m.test(intro) ? '' : intro.trim().replace(/\s*\n\s*/g, ' ');
  return { summary, entries: summary ? entries : section.trim() };
}

/** Derives a one-line summary from the number of top-level entries in each category. */
export function deriveSummary(entries) {
  const counts = [];
  let category = null;
  for (const line of entries.split('\n')) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      category = heading[1];
      continue;
    }
    if (category && /^[-*]\s/.test(line)) {
      const entry = counts.find((c) => c.category === category);
      if (entry) entry.count++;
      else counts.push({ category, count: 1 });
    }
  }
  const parts = counts.map(({ category, count }) => {
    const [one, many] = CATEGORY_NOUNS[category] ?? [category.toLowerCase(), category.toLowerCase()];
    return `${count} ${count === 1 ? one : many}`;
  });
  if (parts.length === 0) return '';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return `${list[0].toUpperCase()}${list.slice(1)}.`;
}

/**
 * Rewrites relative Markdown links (`[x](docs/REFERENCE.md)`) to absolute links at the
 * release tag, since a release page resolves them against /releases/tag/ and 404s.
 */
export function absolutizeLinks(markdown, repoUrl, tag) {
  return markdown.replace(/\]\((?![a-z][a-z0-9+.-]*:|#|\/)([^)\s]+)\)/gi, (_, path) => {
    return `](${repoUrl}/blob/${tag}/${path.replace(/^\.\//, '')})`;
  });
}

/** Assembles the release body. */
export function buildReleaseNotes({ changelogText, section, version, packageName, repoUrl, installSizeReport }) {
  const tag = `v${version}`;
  const { summary, entries } = splitSummary(extractSection(changelogText, section) ?? '');
  const headline = summary || deriveSummary(entries);

  const blocks = [];
  if (headline) blocks.push(absolutizeLinks(headline, repoUrl, tag));
  if (entries) blocks.push(absolutizeLinks(entries, repoUrl, tag));
  blocks.push(
    [
      '## Install',
      '',
      '```bash',
      `npm install -g ${packageName}@${version}`,
      '# or',
      `bun install -g ${packageName}@${version}`,
      '```',
    ].join('\n')
  );
  if (installSizeReport?.trim()) blocks.push(installSizeReport.trim());
  return `${blocks.join('\n\n')}\n`;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version' || arg === '--section' || arg === '--out') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.version) throw new Error('--version is required');
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const repoUrl = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
  const notes = buildReleaseNotes({
    changelogText: readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8'),
    section: options.section ?? options.version,
    version: options.version,
    packageName: pkg.name,
    repoUrl,
    installSizeReport: process.env.INSTALL_SIZE_REPORT,
  });
  if (options.out) writeFileSync(options.out, notes);
  else process.stdout.write(notes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`release-notes: ${error.message}`);
    process.exit(1);
  }
}
