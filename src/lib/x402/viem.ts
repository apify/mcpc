/**
 * viem boundary module — the ONLY file in src/ allowed to import from viem.
 *
 * At build time, `scripts/bundle-viem.mjs` overwrites the tsc-compiled
 * dist/lib/x402/viem.js with a self-contained, tree-shaken esbuild bundle, so
 * viem can stay a devDependency and the published package is ~35 MB smaller.
 * During development (plain tsc / tsc --watch / vitest), the compiled
 * re-exports resolve against the installed devDependency as usual.
 *
 * Rules for this file:
 * - No relative imports. The bundler would inline them, creating a second copy
 *   (separate module identity) of anything they define (e.g. a duplicate
 *   ClientError class that breaks instanceof checks).
 * - Export only what the x402 feature actually uses — every extra symbol grows
 *   the bundle. `scripts/bundle-viem.mjs` enforces tree-shaking invariants.
 */
export {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  formatEther,
  formatUnits,
  erc20Abi,
} from 'viem';
export { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
export { base, baseSepolia } from 'viem/chains';

/** Self-contained Hex type (identical to viem's) so published .d.ts files never reference viem. */
export type Hex = `0x${string}`;
