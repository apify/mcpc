/**
 * Tests for the release dependency-age gate (scripts/check-dependency-age.mjs).
 *
 * The gate is only worth having if it cannot silently under-report, so these tests
 * concentrate on the ways its hand-rolled lockfile parsing could quietly drop packages
 * and still print a pass:
 *   - four-space keys nested under a package (`engines:`, `resolution:`,
 *     `peerDependencies:`) must not be mistaken for package entries
 *   - peer suffixes (`sdk@1.30.0(zod@4.4.3)`) contain an `@`, so splitting the raw key
 *     on the last `@` yields a nonsense name and drops the package from the closure
 *   - `transitivePeerDependencies:` is a bare name list and must not be walked
 *   - dev-only dependencies must stay out of the production closure
 *
 * Everything here is pure: publish times are injected, so no registry is contacted.
 */

// @ts-expect-error - plain .mjs script with no type declarations (scripts/ is not compiled)
import {
  splitNameVersion,
  stripPeerSuffix,
  parseLockfilePackages,
  productionClosure,
  parseAgePolicy,
  evaluateAges,
} from '../../scripts/check-dependency-age.mjs';

/**
 * A miniature pnpm v9 lockfile exercising every shape the parser has to survive:
 * a scoped package with a peer suffix, quoted and unquoted keys, nested four-space
 * metadata keys, a dev-only dependency with its own transitive dep, and a
 * `transitivePeerDependencies` list.
 */
const LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      '@modelcontextprotocol/sdk':
        specifier: ^1.30.0
        version: 1.30.0(zod@4.4.3)
      chalk:
        specifier: ^5.6.2
        version: 5.6.2
    devDependencies:
      vitest:
        specifier: ^4.0.0
        version: 4.0.0

packages:

  '@modelcontextprotocol/sdk@1.30.0':
    resolution: {integrity: sha512-aaa==}
    engines: {node: '>=18'}
    peerDependencies:
      zod: ^4.0.0

  chalk@5.6.2:
    resolution: {integrity: sha512-bbb==}
    engines: {node: '>=10'}

  zod@4.4.3:
    resolution: {integrity: sha512-ccc==}

  vitest@4.0.0:
    resolution: {integrity: sha512-ddd==}
    hasBin: true

  debug@4.4.3:
    resolution: {integrity: sha512-eee==}

snapshots:

  '@modelcontextprotocol/sdk@1.30.0(zod@4.4.3)':
    dependencies:
      zod: 4.4.3
    transitivePeerDependencies:
      - supports-color

  chalk@5.6.2: {}

  zod@4.4.3: {}

  vitest@4.0.0:
    dependencies:
      debug: 4.4.3

  debug@4.4.3: {}
`;

const WORKSPACE = `minimumReleaseAge: 7200

minimumReleaseAgeExclude:
  - "@modelcontextprotocol/client"
  - "@modelcontextprotocol/sdk"

onlyBuiltDependencies:
  - "@napi-rs/keyring"
`;

interface Entry {
  name: string;
  version: string;
}

describe('splitNameVersion', () => {
  it('splits plain and scoped names', () => {
    expect(splitNameVersion('chalk@5.6.2')).toEqual({ name: 'chalk', version: '5.6.2' });
    expect(splitNameVersion('@babel/core@7.29.0')).toEqual({
      name: '@babel/core',
      version: '7.29.0',
    });
  });

  it('strips the peer suffix before splitting, so the @ inside it is not the separator', () => {
    // Regression: lastIndexOf('@') on the raw key returns the '@' inside '(zod@4.4.3)',
    // producing name '@modelcontextprotocol/sdk@1.30.0(zod' and version '4.4.3)'.
    expect(splitNameVersion('@modelcontextprotocol/sdk@1.30.0(zod@4.4.3)')).toEqual({
      name: '@modelcontextprotocol/sdk',
      version: '1.30.0',
    });
  });

  it('returns null for keys that carry no version', () => {
    expect(splitNameVersion('chalk')).toBeNull();
    expect(splitNameVersion('@scope/pkg')).toBeNull();
  });
});

describe('stripPeerSuffix', () => {
  it('removes a peer context and leaves plain versions alone', () => {
    expect(stripPeerSuffix('1.30.0(zod@4.4.3)')).toBe('1.30.0');
    expect(stripPeerSuffix('7.28.6(@babel/core@7.29.0)')).toBe('7.28.6');
    expect(stripPeerSuffix('5.6.2')).toBe('5.6.2');
  });
});

describe('parseLockfilePackages', () => {
  const entries = parseLockfilePackages(LOCKFILE) as Entry[];

  it('returns every pinned version exactly once', () => {
    expect(entries.map((e) => `${e.name}@${e.version}`).sort()).toEqual([
      '@modelcontextprotocol/sdk@1.30.0',
      'chalk@5.6.2',
      'debug@4.4.3',
      'vitest@4.0.0',
      'zod@4.4.3',
    ]);
  });

  it('ignores the four-space metadata keys nested under each package', () => {
    // The indentation trap: /^ {2}(.+?):$/ would also match `    engines:` because `.`
    // eats the extra two spaces, inventing packages named engines/resolution/hasBin.
    const names = entries.map((e) => e.name);
    for (const trap of ['engines', 'resolution', 'peerDependencies', 'hasBin']) {
      expect(names).not.toContain(trap);
    }
  });

  it('refuses to report success on a lockfile it cannot parse', () => {
    // Fail closed: 0 packages means the format changed, not that there is nothing to check.
    expect(() => parseLockfilePackages('lockfileVersion: 9.0\n')).toThrow(/Parsed 0 packages/);
  });
});

describe('productionClosure', () => {
  const closure = productionClosure(LOCKFILE) as Set<string>;

  it('includes production roots and their transitive dependencies', () => {
    // sdk is reachable only through its peer-suffixed snapshot key; zod only through sdk.
    expect([...closure].sort()).toEqual([
      '@modelcontextprotocol/sdk@1.30.0',
      'chalk@5.6.2',
      'zod@4.4.3',
    ]);
  });

  it('excludes dev-only dependencies and their transitives', () => {
    expect(closure.has('vitest@4.0.0')).toBe(false);
    expect(closure.has('debug@4.4.3')).toBe(false);
  });

  it('does not treat transitivePeerDependencies entries as packages', () => {
    expect([...closure].some((key) => key.includes('supports-color'))).toBe(false);
  });
});

describe('parseAgePolicy', () => {
  it('reads the threshold and the exclusion list', () => {
    expect(parseAgePolicy(WORKSPACE)).toEqual({
      minAgeMinutes: 7200,
      exclude: ['@modelcontextprotocol/client', '@modelcontextprotocol/sdk'],
    });
  });

  it('throws rather than assuming a default threshold', () => {
    expect(() => parseAgePolicy('onlyBuiltDependencies:\n  - foo\n')).toThrow(
      /No `minimumReleaseAge` found/
    );
  });
});

describe('evaluateAges', () => {
  const NOW = Date.parse('2026-07-31T00:00:00Z');
  const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

  const policy = { minAgeMinutes: 7200, exclude: ['@modelcontextprotocol/*'] };
  const base = {
    policy,
    excludeMinAgeMinutes: 2880,
    nowMillis: NOW,
  };

  it('flags a normal package below the 5-day threshold', () => {
    const { violations } = evaluateAges({
      ...base,
      entries: [{ name: 'chalk', version: '5.6.2' }],
      publishTimes: { chalk: { '5.6.2': daysAgo(1) } },
    });
    expect(violations.map((v: Entry) => v.name)).toEqual(['chalk']);
  });

  it('passes a normal package above the threshold', () => {
    const { violations, checked } = evaluateAges({
      ...base,
      entries: [{ name: 'chalk', version: '5.6.2' }],
      publishTimes: { chalk: { '5.6.2': daysAgo(30) } },
    });
    expect(violations).toEqual([]);
    expect(checked[0].isExcluded).toBe(false);
  });

  it('lets an excluded package through below 5 days but above the 48-hour floor', () => {
    const { violations, checked } = evaluateAges({
      ...base,
      entries: [{ name: '@modelcontextprotocol/sdk', version: '1.30.0' }],
      publishTimes: { '@modelcontextprotocol/sdk': { '1.30.0': daysAgo(4) } },
    });
    expect(violations).toEqual([]);
    expect(checked[0].isExcluded).toBe(true);
    expect(checked[0].minAgeMinutes).toBe(2880);
  });

  it('still blocks an excluded package below the 48-hour floor', () => {
    // The whole point of the floor: an exemption is not a free pass for a same-day publish.
    const { violations } = evaluateAges({
      ...base,
      entries: [{ name: '@modelcontextprotocol/sdk', version: '1.30.0' }],
      publishTimes: { '@modelcontextprotocol/sdk': { '1.30.0': daysAgo(0.5) } },
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].isExcluded).toBe(true);
  });

  it('reports a missing publish time as an error instead of a pass', () => {
    const { errors, violations, checked } = evaluateAges({
      ...base,
      entries: [{ name: 'chalk', version: '5.6.2' }],
      publishTimes: { chalk: { '5.6.1': daysAgo(30) } },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/chalk@5\.6\.2/);
    // Not counted as checked, and not silently treated as a violation-free entry.
    expect(checked).toEqual([]);
    expect(violations).toEqual([]);
  });

  it('sorts the report youngest first', () => {
    const { checked } = evaluateAges({
      ...base,
      entries: [
        { name: 'old', version: '1.0.0' },
        { name: 'young', version: '1.0.0' },
        { name: 'middle', version: '1.0.0' },
      ],
      publishTimes: {
        old: { '1.0.0': daysAgo(100) },
        young: { '1.0.0': daysAgo(6) },
        middle: { '1.0.0': daysAgo(20) },
      },
    });
    expect(checked.map((c: Entry) => c.name)).toEqual(['young', 'middle', 'old']);
  });
});
