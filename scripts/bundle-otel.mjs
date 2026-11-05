/**
 * Bundles the OpenTelemetry boundary module (src/lib/otel/otel.ts) into a single
 * self-contained ESM file, overwriting the tsc-compiled re-export stub at
 * dist/lib/otel/otel.js. This lets the OpenTelemetry SDK live in devDependencies:
 * users installing @apify/mcpc download a tree-shaken bundle of about 1 MB instead of
 * the SDK's dependency tree, and only a bridge started with `--otel` ever loads it.
 *
 * Runs as part of `pnpm run build` (after tsc, next to bundle-viem.mjs). The
 * tsc-generated otel.d.ts is kept, so TypeScript consumers within the repo see
 * unchanged types.
 */
import { build } from 'esbuild';
import { rm, stat } from 'fs/promises';

const OUTFILE = 'dist/lib/otel/otel.js';

const result = await build({
  entryPoints: ['src/lib/otel/otel.ts'],
  outfile: OUTFILE,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // Unminified for debuggable stack traces (same trade-off as the viem bundle).
  minify: false,
  sourcemap: false,
  // Keep the Apache-2.0 license headers of the vendored packages in the artifact.
  legalComments: 'eof',
  metafile: true,
  logLevel: 'silent',
});

// tsc emitted a sourcemap for the re-export stub we just overwrote — remove it.
await rm(`${OUTFILE}.map`, { force: true });

// Guards: fail the build if the bundle grows the wrong way. Do NOT "fix" a failure by
// marking packages external — that only defers the error to runtime for users.
const output = result.metafile.outputs[OUTFILE];
const bundled = Object.entries(output.inputs)
  .filter(([, info]) => info.bytesInOutput > 0)
  .map(([path]) => path);

// Only the OTLP/HTTP (JSON) exporters are used; the gRPC and protobuf stacks must never
// be pulled in (they would dwarf everything else in the package).
const heavyDeps = bundled.filter((p) => /node_modules\/(@grpc|protobufjs|long)\//.test(p));
if (heavyDeps.length > 0) {
  throw new Error(
    `otel bundle contains gRPC/protobuf deps (should not be reachable):\n${heavyDeps.join('\n')}`
  );
}

// Every @opentelemetry package must be inlined — a bare import left in the bundle would
// fail at runtime for users, since none of them is a runtime dependency.
const externalOtel = Object.keys(output.imports ?? {}).filter((p) => p.startsWith('@opentelemetry/'));
const leftover = (output.imports ?? [])
  .map((entry) => entry.path)
  .filter((path) => path.startsWith('@opentelemetry/'));
if (externalOtel.length > 0 || leftover.length > 0) {
  throw new Error(`otel bundle still imports @opentelemetry packages: ${leftover.join(', ')}`);
}

const { size } = await stat(OUTFILE);
if (size > 3 * 1024 * 1024) {
  throw new Error(`otel bundle unexpectedly large (${size} bytes) — check tree-shaking`);
}
console.log(`otel bundle: ${(size / 1024).toFixed(0)} KiB, ${bundled.length} modules`);
