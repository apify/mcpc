/**
 * Bundles the viem boundary module (src/lib/x402/viem.ts) into a single
 * self-contained ESM file, overwriting the tsc-compiled re-export stub at
 * dist/lib/x402/viem.js. This lets viem live in devDependencies: users
 * installing @apify/mcpc download a ~1 MB tree-shaken bundle instead of
 * viem's ~35 MB dependency tree.
 *
 * Runs as part of `pnpm run build` (after tsc). The tsc-generated viem.d.ts
 * is kept, so TypeScript consumers within the repo see unchanged types.
 */
import { build } from 'esbuild';
import { rm, stat } from 'fs/promises';

const OUTFILE = 'dist/lib/x402/viem.js';

const result = await build({
  entryPoints: ['src/lib/x402/viem.ts'],
  outfile: OUTFILE,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // Unminified for debuggable stack traces; the size delta (~0.5 MB) is noise
  // next to the ~35 MB of dependencies this replaces.
  minify: false,
  // Don't ship a multi-MB sourcemap of vendored code.
  sourcemap: false,
  // Keep viem/@noble MIT license headers in the artifact.
  legalComments: 'eof',
  metafile: true,
  logLevel: 'silent',
});

// tsc emitted a sourcemap for the re-export stub we just overwrote — remove it.
await rm(`${OUTFILE}.map`, { force: true });

// Guards: fail the build if tree-shaking regresses. Do NOT "fix" a failure by
// marking packages external — that only defers the error to runtime for users.
// Note: metafile.inputs is the full parse graph (everything esbuild *visited*);
// what actually ships is outputs[].inputs with bytesInOutput > 0.
const output = result.metafile.outputs[OUTFILE];
const bundled = Object.entries(output.inputs)
  .filter(([, info]) => info.bytesInOutput > 0)
  .map(([path]) => path);

// ws/isows are only reachable via viem's websocket transports; mcpc uses only
// the http() transport, so they must tree-shake away entirely.
const websocketDeps = bundled.filter((p) => /node_modules\/(ws|isows)\//.test(p));
if (websocketDeps.length > 0) {
  throw new Error(
    `viem bundle contains websocket deps (should tree-shake away):\n${websocketDeps.join('\n')}`
  );
}

// Only base + baseSepolia are imported; more means the viem/chains barrel
// (~700 chain definitions) stopped tree-shaking.
const chainDefs = bundled.filter((p) => p.includes('chains/definitions/'));
if (chainDefs.length > 4) {
  throw new Error(
    `viem bundle contains ${chainDefs.length} chain definitions (expected 2: base, baseSepolia)`
  );
}

const { size } = await stat(OUTFILE);
if (size > 4 * 1024 * 1024) {
  throw new Error(`viem bundle unexpectedly large (${size} bytes) — check tree-shaking`);
}
console.log(`viem bundle: ${(size / 1024).toFixed(0)} KiB, ${bundled.length} modules`);
