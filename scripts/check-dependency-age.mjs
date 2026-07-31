#!/usr/bin/env node
/**
 * Release gate: verify every dependency version pinned in `pnpm-lock.yaml` has been
 * on the npm registry long enough to be trusted.
 *
 * Why this script exists at all: `minimumReleaseAge` in `pnpm-workspace.yaml` is a
 * *resolution-time* setting. pnpm 10 (this repo pins 10.33.4) does not re-apply it to
 * the entries of an existing lockfile — that verification pass landed in pnpm 11
 * (pnpm/pnpm#10438). CI and the release workflow both install with
 * `--frozen-lockfile`, so without this script no age check runs during a release at
 * all: whatever a human or Renovate resolved into the lockfile ships, however fresh it
 * was at the moment it was written. Delete this script once the repo is on pnpm >= 11
 * and `verifyDepsBeforeRun`/lockfile age verification covers it natively.
 *
 * Thresholds are read from `pnpm-workspace.yaml` so there is exactly one source of
 * truth, with one deliberate difference: packages listed in `minimumReleaseAgeExclude`
 * are not waved through, they get a shorter hard floor (48 h by default). A package we
 * track closely still needs to survive a day on the registry, which is where
 * compromised-publish detection actually happens.
 *
 * The check FAILS CLOSED. A registry error, an unparseable config, or a version with no
 * publish time is a failure, not a skip — a release gate that goes green on a network
 * blip is worse than no gate, because it reports safety it never established.
 *
 * Usage:
 *   node scripts/check-dependency-age.mjs [options]
 *
 *   --prod-only                    only check the production dependency closure
 *   --min-age-minutes <n>          override minimumReleaseAge from pnpm-workspace.yaml
 *   --exclude-min-age-minutes <n>  floor for excluded packages (default 2880 = 48 h)
 *   --registry <url>               registry base URL (default https://registry.npmjs.org)
 *   --json                         machine-readable report on stdout
 *
 * Exits 0 when everything is old enough, 1 otherwise.
 */
import { appendFileSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// Resolve the lockfile from this script's location, not the cwd, so the gate behaves the
// same whether it is invoked via `pnpm run check:deps-age`, from scripts/publish.sh, or
// by an absolute path from somewhere else entirely.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const MILLIS_PER_MINUTE = 60 * 1000;
const MILLIS_PER_DAY = 24 * 60 * MILLIS_PER_MINUTE;
/** Hard floor for packages exempted via minimumReleaseAgeExclude: 48 hours. */
const DEFAULT_EXCLUDE_MIN_AGE_MINUTES = 2880;
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const REGISTRY_CONCURRENCY = 12;
const REGISTRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MILLIS = 1000;
/** How many of the youngest packages to list in the report. */
const REPORT_ROWS = 15;

// ── Lockfile parsing ──────────────────────────────────────────────────────────
//
// Hand-rolled rather than pulling in a YAML dependency (the repo deliberately keeps
// dependencies minimal). The lockfile shape this relies on is narrow and asserted by
// unit tests: `packages:` and `snapshots:` are top-level keys whose children are
// indented exactly two spaces.
//
// The trap worth calling out: a naive /^ {2}(.+?):$/ also matches four-space keys like
// `resolution:`, `engines:` and `peerDependencies:` nested under each package, because
// `.` happily eats the extra spaces. Every pattern below therefore requires a
// non-space character at index 2.

/** Strip surrounding single/double quotes from a YAML scalar. */
function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed.startsWith("'") || trimmed.startsWith('"'))) {
    const quote = trimmed[0];
    if (trimmed.endsWith(quote)) return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Split a lockfile key like `@babel/core@7.29.0` or `chalk@5.6.2` into name and version.
 * Returns null for keys that are not `name@version` (nothing in a v9 lockfile should be).
 *
 * The peer suffix must be stripped first: `@modelcontextprotocol/sdk@1.30.0(zod@4.4.3)`
 * contains an `@` inside the parentheses, so splitting on the last `@` of the raw key
 * yields a nonsense name and version — which would silently drop the package from the
 * production closure and report a pass for a version nobody checked.
 */
export function splitNameVersion(key) {
  const base = stripPeerSuffix(key);
  const at = base.lastIndexOf('@');
  if (at <= 0) return null;
  const name = base.slice(0, at);
  const version = base.slice(at + 1);
  if (!name || !version) return null;
  return { name, version };
}

/**
 * pnpm appends the peer-dependency context it resolved against to snapshot keys and
 * dependency values, e.g. `1.30.0(zod@4.4.3)`. The registry knows nothing about that
 * suffix, so strip it to get the version that was actually published. Safe to apply to
 * a whole `name@version(peers)` key too — only peer suffixes introduce parentheses.
 */
export function stripPeerSuffix(value) {
  const paren = value.indexOf('(');
  return paren === -1 ? value : value.slice(0, paren);
}

/**
 * Yield the two-space-indented child keys of a given top-level lockfile section,
 * in file order.
 */
function* sectionKeys(lockfileText, section) {
  let inSection = false;
  for (const line of lockfileText.split('\n')) {
    if (/^\S/.test(line)) {
      // Any column-0 key starts a new top-level section (and ends ours).
      inSection = new RegExp(`^${section}:\\s*$`).test(line);
      continue;
    }
    if (!inSection) continue;
    // Exactly two spaces, then a non-space: a direct child of the section.
    const match = /^ {2}(\S.*?):\s*$/.exec(line);
    if (match) yield unquote(match[1]);
  }
}

/**
 * Every `name@version` pinned in the lockfile's `packages:` section — i.e. every
 * distinct tarball an install of this repo would download.
 */
export function parseLockfilePackages(lockfileText) {
  const entries = [];
  for (const key of sectionKeys(lockfileText, 'packages')) {
    const split = splitNameVersion(key);
    if (!split) continue;
    // splitNameVersion already strips any peer suffix, so a future pnpm lockfile that
    // starts adding them to `packages:` keys degrades into a correct lookup.
    entries.push({ name: split.name, version: split.version, key });
  }
  if (entries.length === 0) {
    throw new Error(
      'Parsed 0 packages from pnpm-lock.yaml — the lockfile format is not what this script expects. ' +
        'Refusing to report a pass. Update scripts/check-dependency-age.mjs.'
    );
  }
  return entries;
}

/**
 * Parse `snapshots:` into a dependency graph: snapshot key -> array of dependency
 * snapshot keys (peer suffixes retained, since they are part of the key).
 */
function parseSnapshotGraph(lockfileText) {
  const graph = new Map();
  let inSnapshots = false;
  let current = null;
  let inDependencySection = false;

  for (const line of lockfileText.split('\n')) {
    if (/^\S/.test(line)) {
      inSnapshots = /^snapshots:\s*$/.test(line);
      current = null;
      continue;
    }
    if (!inSnapshots) continue;

    const snapshotKey = /^ {2}(\S.*?):\s*(\{\})?\s*$/.exec(line);
    if (snapshotKey) {
      current = unquote(snapshotKey[1]);
      graph.set(current, []);
      inDependencySection = false;
      continue;
    }
    if (!current) continue;

    // Four-space section header under a snapshot. `dependencies` and
    // `optionalDependencies` contribute real installs; `transitivePeerDependencies`
    // is a bare list of names with no versions and must not be walked.
    const sectionHeader = /^ {4}(\S.*?):\s*$/.exec(line);
    if (sectionHeader) {
      const name = unquote(sectionHeader[1]);
      inDependencySection = name === 'dependencies' || name === 'optionalDependencies';
      continue;
    }

    if (!inDependencySection) continue;
    const edge = /^ {6}(\S.*?):\s*(\S.*?)\s*$/.exec(line);
    if (edge) {
      graph.get(current).push(`${unquote(edge[1])}@${unquote(edge[2])}`);
    }
  }
  return graph;
}

/** Direct production dependencies of every importer (workspace package). */
function parseImporterProdDeps(lockfileText) {
  const roots = [];
  let inImporters = false;
  let inProdSection = false;
  let depName = null;

  for (const line of lockfileText.split('\n')) {
    if (/^\S/.test(line)) {
      inImporters = /^importers:\s*$/.test(line);
      continue;
    }
    if (!inImporters) continue;

    if (/^ {2}\S/.test(line)) {
      // New importer — reset section state.
      inProdSection = false;
      depName = null;
      continue;
    }
    const sectionHeader = /^ {4}(\S.*?):\s*$/.exec(line);
    if (sectionHeader) {
      const name = unquote(sectionHeader[1]);
      inProdSection = name === 'dependencies' || name === 'optionalDependencies';
      depName = null;
      continue;
    }
    if (!inProdSection) continue;

    const nameLine = /^ {6}(\S.*?):\s*$/.exec(line);
    if (nameLine) {
      depName = unquote(nameLine[1]);
      continue;
    }
    const versionLine = /^ {8}version:\s*(\S.*?)\s*$/.exec(line);
    if (versionLine && depName) {
      roots.push(`${depName}@${unquote(versionLine[1])}`);
      depName = null;
    }
  }
  return roots;
}

/**
 * The set of `name@version` (peer suffixes stripped) reachable from the production
 * dependencies of every importer — what actually lands in a user's node_modules.
 */
export function productionClosure(lockfileText) {
  const graph = parseSnapshotGraph(lockfileText);
  const queue = parseImporterProdDeps(lockfileText);
  const visited = new Set();
  const closure = new Set();

  while (queue.length > 0) {
    const node = queue.pop();
    if (visited.has(node)) continue;
    visited.add(node);

    const split = splitNameVersion(node);
    if (split) closure.add(`${split.name}@${split.version}`);

    for (const dep of graph.get(node) ?? []) queue.push(dep);
  }
  return closure;
}

// ── Policy parsing ────────────────────────────────────────────────────────────

/** Translate a pnpm exclude pattern (only `*` is supported) into a RegExp. */
function patternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Read `minimumReleaseAge` and `minimumReleaseAgeExclude` out of pnpm-workspace.yaml.
 * Throws when `minimumReleaseAge` is absent — better to fail the release than to
 * silently check against a made-up default.
 */
export function parseAgePolicy(workspaceText) {
  const ageMatch = /^minimumReleaseAge:\s*(\d+)\s*$/m.exec(workspaceText);
  if (!ageMatch) {
    throw new Error(
      'No `minimumReleaseAge` found in pnpm-workspace.yaml. Refusing to guess a threshold — ' +
        'set it, or pass --min-age-minutes explicitly.'
    );
  }
  const minAgeMinutes = Number(ageMatch[1]);

  const exclude = [];
  const lines = workspaceText.split('\n');
  const startIndex = lines.findIndex((line) => /^minimumReleaseAgeExclude:\s*$/.test(line));
  if (startIndex !== -1) {
    for (const line of lines.slice(startIndex + 1)) {
      const item = /^ {2}-\s*(\S.*?)\s*$/.exec(line);
      if (!item) break; // end of the list
      exclude.push(unquote(item[1]));
    }
  }
  return { minAgeMinutes, exclude };
}

// ── Registry lookups ──────────────────────────────────────────────────────────

function sleep(millis) {
  return new Promise((resolve) => setTimeout(resolve, millis));
}

/**
 * Fetch a package's `time` map (version -> ISO publish timestamp) from the registry.
 *
 * Uses the full packument: the abbreviated `application/vnd.npm.install-v1+json`
 * document is much smaller but omits `time` entirely, which is the one field needed
 * here. Responses are gzipped by `fetch`, so the wire cost is a fraction of the
 * decompressed size.
 */
async function fetchPublishTimes(name, registry) {
  // Scoped names must keep their slash encoded, otherwise it reads as a path segment.
  const url = `${registry.replace(/\/$/, '')}/${name.replace('/', '%2f')}`;
  let lastError;
  for (let attempt = 1; attempt <= REGISTRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const document = await response.json();
      if (!document.time || typeof document.time !== 'object') {
        throw new Error('registry response has no `time` map');
      }
      return document.time;
    } catch (error) {
      lastError = error;
      if (attempt < REGISTRY_ATTEMPTS) {
        await sleep(RETRY_BASE_DELAY_MILLIS * 2 ** (attempt - 1));
      }
    }
  }
  throw new Error(`${name}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Evaluation ────────────────────────────────────────────────────────────────

/**
 * Decide, for each lockfile entry, whether it is old enough.
 *
 * Pure and synchronous so it can be unit-tested without touching the network:
 * `publishTimes` maps package name -> { version: ISO timestamp }.
 */
export function evaluateAges({ entries, publishTimes, policy, excludeMinAgeMinutes, nowMillis }) {
  const excludePatterns = policy.exclude.map(patternToRegExp);
  const checked = [];
  const errors = [];

  for (const entry of entries) {
    const isExcluded = excludePatterns.some((pattern) => pattern.test(entry.name));
    const minAgeMinutes = isExcluded ? excludeMinAgeMinutes : policy.minAgeMinutes;

    const published = publishTimes[entry.name]?.[entry.version];
    if (!published) {
      errors.push(`${entry.name}@${entry.version}: no publish time on the registry`);
      continue;
    }
    const publishedMillis = Date.parse(published);
    if (Number.isNaN(publishedMillis)) {
      errors.push(`${entry.name}@${entry.version}: unparseable publish time "${published}"`);
      continue;
    }

    const ageMinutes = (nowMillis - publishedMillis) / MILLIS_PER_MINUTE;
    checked.push({
      name: entry.name,
      version: entry.version,
      published,
      ageMinutes,
      ageDays: (nowMillis - publishedMillis) / MILLIS_PER_DAY,
      isExcluded,
      minAgeMinutes,
      tooYoung: ageMinutes < minAgeMinutes,
    });
  }

  checked.sort((a, b) => a.ageMinutes - b.ageMinutes);
  return { checked, violations: checked.filter((entry) => entry.tooYoung), errors };
}

// ── Reporting ─────────────────────────────────────────────────────────────────

function formatDays(days) {
  return `${days.toFixed(2)} d`;
}

function buildReport({ checked, violations, scopeLabel, policy, excludeMinAgeMinutes }) {
  const rows = checked
    .slice(0, REPORT_ROWS)
    .map(
      (entry) =>
        `| \`${entry.name}@${entry.version}\` | ${formatDays(entry.ageDays)} | ` +
        `${formatDays(entry.minAgeMinutes / (24 * 60))} | ` +
        `${entry.tooYoung ? '❌ too young' : entry.isExcluded ? '⚠️ exempt' : '✅'} |`
    );

  return [
    '#### Dependency age',
    '',
    `Checked ${checked.length} ${scopeLabel} against a ${formatDays(policy.minAgeMinutes / (24 * 60))} ` +
      `minimum (${formatDays(excludeMinAgeMinutes / (24 * 60))} for the ${policy.exclude.length} ` +
      `exempted package pattern(s)).`,
    '',
    `Youngest ${Math.min(REPORT_ROWS, checked.length)}:`,
    '',
    '| Package | Age | Required | Status |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    violations.length === 0
      ? '✅ All dependencies are old enough to publish.'
      : `❌ ${violations.length} dependency version(s) are too young to publish.`,
    '',
  ].join('\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {
    prodOnly: false,
    minAgeMinutes: null,
    excludeMinAgeMinutes: DEFAULT_EXCLUDE_MIN_AGE_MINUTES,
    registry: DEFAULT_REGISTRY,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`Missing value for ${arg}`);
      return next;
    };
    switch (arg) {
      case '--prod-only':
        options.prodOnly = true;
        break;
      case '--min-age-minutes':
        options.minAgeMinutes = Number(value());
        break;
      case '--exclude-min-age-minutes':
        options.excludeMinAgeMinutes = Number(value());
        break;
      case '--registry':
        options.registry = value();
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  for (const key of ['minAgeMinutes', 'excludeMinAgeMinutes']) {
    if (options[key] !== null && Number.isNaN(options[key])) {
      throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a number`);
    }
  }
  return options;
}

const USAGE = `Usage: node scripts/check-dependency-age.mjs [options]

  --prod-only                    only check the production dependency closure
  --min-age-minutes <n>          override minimumReleaseAge from pnpm-workspace.yaml
  --exclude-min-age-minutes <n>  floor for excluded packages (default ${DEFAULT_EXCLUDE_MIN_AGE_MINUTES})
  --registry <url>               registry base URL (default ${DEFAULT_REGISTRY})
  --json                         machine-readable report on stdout
`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const lockfileText = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');
  const workspaceText = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');

  const policy = parseAgePolicy(workspaceText);
  if (options.minAgeMinutes !== null) policy.minAgeMinutes = options.minAgeMinutes;

  let entries = parseLockfilePackages(lockfileText);
  let scopeLabel = 'locked package versions';
  if (options.prodOnly) {
    const closure = productionClosure(lockfileText);
    entries = entries.filter((entry) => closure.has(`${entry.name}@${entry.version}`));
    scopeLabel = 'production package versions';
    if (entries.length === 0) {
      throw new Error(
        'Production closure came out empty — the lockfile format is not what this script expects. ' +
          'Refusing to report a pass.'
      );
    }
  }

  // One request per package name, not per version: a packument covers every version.
  const names = [...new Set(entries.map((entry) => entry.name))];
  if (!options.json) {
    console.log(
      `Checking ${entries.length} ${scopeLabel} (${names.length} packages) against the registry...`
    );
  }

  const publishTimes = {};
  const fetchErrors = [];
  await mapWithConcurrency(names, REGISTRY_CONCURRENCY, async (name) => {
    try {
      publishTimes[name] = await fetchPublishTimes(name, options.registry);
    } catch (error) {
      fetchErrors.push(error instanceof Error ? error.message : String(error));
    }
  });

  const { checked, violations, errors } = evaluateAges({
    entries,
    publishTimes,
    policy,
    excludeMinAgeMinutes: options.excludeMinAgeMinutes,
    nowMillis: Date.now(),
  });
  const allErrors = [...fetchErrors, ...errors];

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          scope: options.prodOnly ? 'production' : 'all',
          minAgeMinutes: policy.minAgeMinutes,
          excludeMinAgeMinutes: options.excludeMinAgeMinutes,
          checkedCount: checked.length,
          violations,
          errors: allErrors,
          youngest: checked.slice(0, REPORT_ROWS),
        },
        null,
        2
      )
    );
  } else {
    const report = buildReport({
      checked,
      violations,
      scopeLabel,
      policy,
      excludeMinAgeMinutes: options.excludeMinAgeMinutes,
    });
    console.log(`\n${report}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
    }
  }

  // Fail closed: unresolved lookups mean the check did not establish anything.
  if (allErrors.length > 0) {
    console.error(
      `\n❌ Could not determine the age of ${allErrors.length} dependency/dependencies:\n` +
        allErrors.map((message) => `   - ${message}`).join('\n') +
        '\n\n   Treating this as a failure: the release age policy was not verified.'
    );
    return 1;
  }

  if (violations.length > 0) {
    console.error(`\n❌ ${violations.length} dependency version(s) are too young to publish:`);
    for (const entry of violations) {
      console.error(
        `   - ${entry.name}@${entry.version}: published ${formatDays(entry.ageDays)} ago, ` +
          `needs ${formatDays(entry.minAgeMinutes / (24 * 60))}` +
          `${entry.isExcluded ? ' (minimumReleaseAgeExclude floor)' : ''}`
      );
    }
    console.error(
      '\n   Wait for the quarantine to elapse, or justify and adjust the policy in pnpm-workspace.yaml.'
    );
    return 1;
  }

  // Success is already stated by the report (human mode) or the data itself (--json),
  // so nothing more goes to stdout here — --json output must stay parseable.
  return 0;
}

// Only run when executed directly, so the parsers above can be unit-tested.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
