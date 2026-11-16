/**
 * viem boundary module — the ONLY file in src/ allowed to import from viem
 * (or from @noble/hashes and @noble/curves, the crypto libraries viem itself uses).
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
// Nano (nano.ts): blake2b and ed25519 with blake2b-512 in place of sha512. Same versions viem
// depends on, so the bundle carries a single copy.
export { blake2b } from '@noble/hashes/blake2b';
export { ed25519 } from '@noble/curves/ed25519';
export { twistedEdwards } from '@noble/curves/abstract/edwards';

/** Self-contained Hex type (identical to viem's) so published .d.ts files never reference viem. */
export type Hex = `0x${string}`;
