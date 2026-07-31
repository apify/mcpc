/**
 * Computes the production install size of the package and compares it with the
 * latest version published to npm, so an unexpectedly large release is caught
 * during the release workflow rather than by users.
 *
 * Measures three things for the current working tree (requires a completed
 * `pnpm run build`) and for the latest published release:
 *   - tarball size (what users download)
 *   - unpacked package size (the package itself inside node_modules)
 *   - full install size (node_modules including all transitive dependencies)
 *
 * Prints a markdown report to stdout, appends it to $GITHUB_STEP_SUMMARY, and
 * writes it as a `report` step output to $GITHUB_OUTPUT when running in GitHub
 * Actions (used to embed it in the release body). Emits a ::warning:: annotation if the full
 * install grew by more than GROWTH_WARN_PCT% (and at least 1 MB) — it does not
 * fail the release; the person releasing decides whether the growth is expected.
 *
 * The comparison with npm degrades gracefully (e.g. first release, registry
 * hiccup), but a failure to pack or install the *new* tarball fails the script,
 * since that means the package itself is broken.
 *
 * Usage: node scripts/report-install-size.mjs (locally or in CI)
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, lstatSync, readFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const GROWTH_WARN_PCT = 20;
const GROWTH_WARN_MIN_BYTES = 1024 * 1024;

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/** Recursive byte size of a directory (symlinks counted as the link itself). */
function dirSize(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const fullPath = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += dirSize(fullPath);
    else total += lstatSync(fullPath).size;
  }
  return total;
}

function mb(bytes) {
  return bytes == null ? 'n/a' : `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function delta(previous, current) {
  if (previous == null || current == null || previous === 0) return 'n/a';
  const pct = ((current - previous) / previous) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

/** Install a tarball or package spec into a fresh temp project and measure it. */
function measureInstall(workDir, label, spec, packageName) {
  const projectDir = join(workDir, label);
  mkdirSync(projectDir);
  // --ignore-scripts: this install exists only to measure bytes on disk, so there is no
  // reason to execute freshly-resolved lifecycle scripts — least of all in the release
  // job, which holds NPM_TOKEN and a push-capable PAT. npm resolves the `^` ranges live
  // here and honours no release-age gate, so those scripts are exactly the code the
  // supply-chain quarantine is meant to keep out.
  run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error', spec], {
    cwd: projectDir,
  });
  const nodeModules = join(projectDir, 'node_modules');
  return {
    installBytes: dirSize(nodeModules),
    unpackedBytes: dirSize(join(nodeModules, ...packageName.split('/'))),
  };
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const workDir = mkdtempSync(join(tmpdir(), 'mcpc-install-size-'));

try {
  // Current working tree: pack, then install the tarball into a fresh project.
  const tarball = join(workDir, 'package.tgz');
  run('pnpm', ['pack', '--out', tarball]);
  const current = {
    tarballBytes: lstatSync(tarball).size,
    ...measureInstall(workDir, 'current', tarball, pkg.name),
  };

  // Latest published release (skipped gracefully on first release / registry errors).
  let previous = null;
  try {
    const latestVersion = JSON.parse(run('npm', ['view', pkg.name, 'version', '--json']));
    const dist = JSON.parse(run('npm', ['view', `${pkg.name}@${latestVersion}`, 'dist', '--json']));
    let tarballBytes = null;
    try {
      // Download and count bytes: HEAD content-length is not reliably present
      // (proxies and CDNs may strip it), and the tarball is only a few MB.
      const response = await fetch(dist.tarball);
      if (response.ok) tarballBytes = (await response.arrayBuffer()).byteLength;
    } catch {
      // Tarball size unavailable; the other metrics still get compared.
    }
    previous = {
      version: latestVersion,
      tarballBytes,
      ...measureInstall(workDir, 'previous', `${pkg.name}@${latestVersion}`, pkg.name),
    };
  } catch {
    // First release or npm unreachable — report current sizes without comparison.
  }

  const previousLabel = previous ? `latest (${previous.version})` : 'latest (none found)';
  const report = [
    '#### Install size',
    '',
    `| Metric | This release | ${previousLabel} | Change |`,
    '| --- | --- | --- | --- |',
    `| Tarball download | ${mb(current.tarballBytes)} | ${mb(previous?.tarballBytes)} | ${delta(previous?.tarballBytes, current.tarballBytes)} |`,
    `| Unpacked package | ${mb(current.unpackedBytes)} | ${mb(previous?.unpackedBytes)} | ${delta(previous?.unpackedBytes, current.unpackedBytes)} |`,
    `| Full install (with dependencies) | ${mb(current.installBytes)} | ${mb(previous?.installBytes)} | ${delta(previous?.installBytes, current.installBytes)} |`,
    '',
  ].join('\n');

  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  }
  // Expose the report as a step output so the workflow can embed it in the
  // GitHub release body (the run summary is not part of the release page).
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `report<<MCPC_REPORT_EOF\n${report}\nMCPC_REPORT_EOF\n`);
  }

  if (previous) {
    for (const [label, previousBytes, currentBytes] of [
      ['tarball download', previous.tarballBytes, current.tarballBytes],
      ['full install', previous.installBytes, current.installBytes],
    ]) {
      if (previousBytes == null) continue;
      const growth = currentBytes - previousBytes;
      if (growth >= GROWTH_WARN_MIN_BYTES && growth / previousBytes >= GROWTH_WARN_PCT / 100) {
        const message = `${pkg.name} ${label} grew from ${mb(previousBytes)} to ${mb(currentBytes)} (${delta(previousBytes, currentBytes)}) vs ${previous.version} — make sure this is expected before releasing.`;
        console.log(process.env.GITHUB_ACTIONS ? `::warning::${message}` : `WARNING: ${message}`);
      }
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
