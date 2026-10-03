/**
 * Tests for the GitHub release body builder (scripts/release-notes.mjs).
 *
 * The first line of the body is what GitHub's social preview card shows for a release
 * URL, so these tests pin that it is the changelog summary (or a derived one), never
 * the install instructions.
 */

// @ts-expect-error - plain .mjs script with no type declarations (scripts/ is not compiled)
import {
  extractSection,
  splitSummary,
  deriveSummary,
  absolutizeLinks,
  buildReleaseNotes,
} from '../../scripts/release-notes.mjs';

const CHANGELOG = `# Changelog

Intro text.

## [Unreleased]

## [1.2.0] - 2026-10-01

Skills support and a faster
bridge startup.

### Added

- New \`skills-list\` command, see [REFERENCE.md](docs/REFERENCE.md).
  Continued line of the same entry.
- Another feature ([spec](https://example.com/spec)).

### Fixed

- A fix. (#12)

## [1.1.0] - 2026-09-01

### Fixed

- Old fix.

[Unreleased]: https://github.com/apify/mcpc/compare/v1.2.0...HEAD
[1.1.0]: https://github.com/apify/mcpc/compare/v1.0.0...v1.1.0
`;

const REPO = 'https://github.com/apify/mcpc';

describe('extractSection', () => {
  it('returns the body of a version section up to the next heading', () => {
    const section = extractSection(CHANGELOG, '1.2.0');
    expect(section.startsWith('Skills support')).toBe(true);
    expect(section.endsWith('- A fix. (#12)')).toBe(true);
  });

  it('stops at the trailing link references for the last section', () => {
    expect(extractSection(CHANGELOG, '1.1.0')).toBe('### Fixed\n\n- Old fix.');
  });

  it('returns an empty string for an empty section and null for a missing one', () => {
    expect(extractSection(CHANGELOG, 'Unreleased')).toBe('');
    expect(extractSection(CHANGELOG, '9.9.9')).toBeNull();
  });
});

describe('splitSummary', () => {
  it('joins the paragraph before the first category into one line', () => {
    const { summary, entries } = splitSummary(extractSection(CHANGELOG, '1.2.0'));
    expect(summary).toBe('Skills support and a faster bridge startup.');
    expect(entries.startsWith('### Added')).toBe(true);
  });

  it('does not treat a bullet list before the first category as a summary', () => {
    expect(splitSummary('- stray entry\n\n### Fixed\n\n- x')).toEqual({
      summary: '',
      entries: '- stray entry\n\n### Fixed\n\n- x',
    });
  });
});

describe('deriveSummary', () => {
  it('counts top-level entries per category, ignoring continuation lines', () => {
    const { entries } = splitSummary(extractSection(CHANGELOG, '1.2.0'));
    expect(deriveSummary(entries)).toBe('2 new features and 1 fix.');
  });

  it('returns an empty string when there are no entries', () => {
    expect(deriveSummary('')).toBe('');
  });
});

describe('absolutizeLinks', () => {
  it('points relative links at the release tag and leaves absolute ones alone', () => {
    expect(absolutizeLinks('[a](docs/A.md) [b](https://x.y/z) [c](#anchor)', REPO, 'v1.2.0')).toBe(
      `[a](${REPO}/blob/v1.2.0/docs/A.md) [b](https://x.y/z) [c](#anchor)`
    );
  });
});

describe('buildReleaseNotes', () => {
  const base = { changelogText: CHANGELOG, packageName: '@apify/mcpc', repoUrl: REPO };

  it('opens with the summary, then entries, install instructions and size report', () => {
    const notes = buildReleaseNotes({
      ...base,
      section: '1.2.0',
      version: '1.2.0',
      installSizeReport: '#### Install size\n\n| a |\n',
    });
    expect(notes.split('\n')[0]).toBe('Skills support and a faster bridge startup.');
    const added = notes.indexOf('### Added');
    const install = notes.indexOf('## Install');
    const size = notes.indexOf('#### Install size');
    expect(added).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(added);
    expect(size).toBeGreaterThan(install);
    expect(notes).toContain('npm install -g @apify/mcpc@1.2.0');
    expect(notes).toContain(`${REPO}/blob/v1.2.0/docs/REFERENCE.md`);
  });

  it('falls back to a derived summary when the section has none', () => {
    const notes = buildReleaseNotes({ ...base, section: '1.1.0', version: '1.1.0' });
    expect(notes.split('\n')[0]).toBe('1 fix.');
  });

  it('still produces install instructions for an empty section', () => {
    const notes = buildReleaseNotes({ ...base, section: 'Unreleased', version: '1.2.1-beta.0' });
    expect(notes.startsWith('## Install')).toBe(true);
    expect(notes).toContain('bun install -g @apify/mcpc@1.2.1-beta.0');
  });
});
