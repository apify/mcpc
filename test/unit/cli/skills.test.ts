/**
 * Tests for the skills command module — the MCP Skills extension
 * (io.modelcontextprotocol/skills): name resolution, relative file references,
 * and the manifest/frontmatter verification that gates what gets printed.
 */

// Mock chalk to return plain strings (the runner can't import chalk's ESM
// at module-load). Matches the mock shape used in output.test.ts — the
// `theme` object in src/cli/output.ts calls chalk.hex(...) at module load,
// so hex must return a function that yields a string-passthrough callable.
vi.mock('chalk', () => {
  const identity = (s: string): string => s;
  const hex = (): ((s: string) => string) => identity;
  const palette = {
    cyan: identity,
    yellow: identity,
    red: identity,
    dim: identity,
    gray: identity,
    bold: identity,
    green: identity,
    greenBright: identity,
    blue: identity,
    magenta: identity,
    white: identity,
    hex,
  };
  return { default: palette, ...palette };
});

// Mock sessions module to avoid loading session state during import
vi.mock('../../../src/lib/sessions.js', () => ({
  getSession: vi.fn().mockResolvedValue(null),
}));

// The command handlers reach the server through withMcpClient; hand them a stub client.
vi.mock('../../../src/cli/helpers.js', () => ({
  withMcpClient: vi.fn(),
}));

import { createHash } from 'crypto';

import {
  getSkill,
  resolveSkillUri,
  resolveSkillFileUri,
  verifyAgainstManifest,
  verifyFrontmatter,
} from '../../../src/cli/commands/skills.js';
import { withMcpClient } from '../../../src/cli/helpers.js';
import { ClientError, ServerError } from '../../../src/lib/errors.js';
import type { IMcpClient, ListSkillsResult, Skill, SkillResource } from '../../../src/lib/types.js';

const SKILL_MD = `---
name: pdf-processing
description: Extract, fill, and assemble PDF documents
---

# PDF processing
`;

function digestOf(text: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex')}`;
}

function skillEntry(overrides: Partial<Skill> = {}): Skill {
  return {
    uri: 'skill://pdf-processing/SKILL.md',
    frontmatter: {
      name: 'pdf-processing',
      description: 'Extract, fill, and assemble PDF documents',
    },
    resources: [
      {
        uri: 'skill://pdf-processing/SKILL.md',
        digest: digestOf(SKILL_MD),
        size: Buffer.byteLength(SKILL_MD),
      },
    ],
    ...overrides,
  };
}

/** Minimal IMcpClient stub that only answers `skills/list`. */
function clientListing(skills: Skill[]): IMcpClient {
  const listSkills = vi.fn().mockResolvedValue({ skills } as ListSkillsResult);
  return { listSkills } as unknown as IMcpClient;
}

describe('resolveSkillUri', () => {
  it('passes through a SKILL.md URI without consulting the listing', async () => {
    const client = clientListing([]);
    await expect(resolveSkillUri(client, 'skill://git-workflow/SKILL.md')).resolves.toBe(
      'skill://git-workflow/SKILL.md'
    );
    expect(client.listSkills).not.toHaveBeenCalled();
  });

  it('appends SKILL.md to a URI naming the skill directory', async () => {
    const client = clientListing([]);
    await expect(resolveSkillUri(client, 'skill://git-workflow')).resolves.toBe(
      'skill://git-workflow/SKILL.md'
    );
    await expect(resolveSkillUri(client, 'skill://acme/billing/refunds/')).resolves.toBe(
      'skill://acme/billing/refunds/SKILL.md'
    );
  });

  it('accepts a non-skill:// scheme, since no scheme is privileged', async () => {
    const client = clientListing([]);
    await expect(
      resolveSkillUri(client, 'github://acme/repo/skills/refunds/SKILL.md')
    ).resolves.toBe('github://acme/repo/skills/refunds/SKILL.md');
  });

  it('resolves a bare name through the listing', async () => {
    const client = clientListing([
      skillEntry({
        uri: 'skill://acme/billing/refunds/SKILL.md',
        frontmatter: { name: 'refunds', description: 'Process refunds' },
      }),
    ]);
    await expect(resolveSkillUri(client, 'refunds')).resolves.toBe(
      'skill://acme/billing/refunds/SKILL.md'
    );
  });

  it('resolves a skill path through the listing', async () => {
    const client = clientListing([
      skillEntry({
        uri: 'skill://acme/billing/refunds/SKILL.md',
        frontmatter: { name: 'refunds', description: 'Process refunds' },
      }),
    ]);
    await expect(resolveSkillUri(client, 'acme/billing/refunds')).resolves.toBe(
      'skill://acme/billing/refunds/SKILL.md'
    );
  });

  it('refuses to pick between two skills sharing a name', async () => {
    const client = clientListing([
      skillEntry({
        uri: 'skill://acme/billing/refunds/SKILL.md',
        frontmatter: { name: 'refunds', description: 'Billing refunds' },
      }),
      skillEntry({
        uri: 'skill://acme/support/refunds/SKILL.md',
        frontmatter: { name: 'refunds', description: 'Support refunds' },
      }),
    ]);
    await expect(resolveSkillUri(client, 'refunds')).rejects.toThrow(ClientError);
    await expect(resolveSkillUri(client, 'refunds')).rejects.toThrow(
      /skill:\/\/acme\/support\/refunds\/SKILL\.md/
    );
  });

  it('falls back to the conventional URI for a name absent from the listing', async () => {
    const client = clientListing([]);
    await expect(resolveSkillUri(client, 'git-workflow')).resolves.toBe(
      'skill://git-workflow/SKILL.md'
    );
  });

  it('rejects an empty name', async () => {
    const client = clientListing([]);
    await expect(resolveSkillUri(client, '   ')).rejects.toThrow(ClientError);
  });
});

describe('resolveSkillFileUri', () => {
  it('resolves a relative reference against the skill root', () => {
    expect(resolveSkillFileUri('skill://pdf-processing/SKILL.md', 'references/FORMS.md')).toBe(
      'skill://pdf-processing/references/FORMS.md'
    );
  });

  it('resolves against a nested skill root', () => {
    expect(resolveSkillFileUri('skill://acme/billing/refunds/SKILL.md', 'examples/email.md')).toBe(
      'skill://acme/billing/refunds/examples/email.md'
    );
  });

  it('tolerates ./ and leading slashes', () => {
    expect(resolveSkillFileUri('skill://pdf/SKILL.md', './scripts/x.py')).toBe(
      'skill://pdf/scripts/x.py'
    );
    expect(resolveSkillFileUri('skill://pdf/SKILL.md', '/scripts/x.py')).toBe(
      'skill://pdf/scripts/x.py'
    );
  });

  it('rejects a path escaping the skill directory', () => {
    expect(() => resolveSkillFileUri('skill://pdf/SKILL.md', '../other/SKILL.md')).toThrow(
      ClientError
    );
  });

  it('rejects an empty path', () => {
    expect(() => resolveSkillFileUri('skill://pdf/SKILL.md', '  ')).toThrow(ClientError);
  });
});

describe('verifyAgainstManifest', () => {
  it('accepts content matching the manifest digest and size', () => {
    expect(() =>
      verifyAgainstManifest(
        skillEntry(),
        'skill://pdf-processing/SKILL.md',
        Buffer.from(SKILL_MD, 'utf-8')
      )
    ).not.toThrow();
  });

  it('rejects content whose digest differs', () => {
    const tampered = Buffer.from(SKILL_MD.replace('Extract', 'Exfiltrate'), 'utf-8');
    const entry = skillEntry({
      resources: [
        {
          uri: 'skill://pdf-processing/SKILL.md',
          digest: digestOf(SKILL_MD),
          size: tampered.length,
        },
      ],
    });
    expect(() => verifyAgainstManifest(entry, 'skill://pdf-processing/SKILL.md', tampered)).toThrow(
      ServerError
    );
  });

  it('rejects content whose byte length differs from the manifest', () => {
    expect(() =>
      verifyAgainstManifest(
        skillEntry(),
        'skill://pdf-processing/SKILL.md',
        Buffer.from(`${SKILL_MD}\n`, 'utf-8')
      )
    ).toThrow(/bytes/);
  });

  it('rejects a file that is not listed in the manifest', () => {
    expect(() =>
      verifyAgainstManifest(
        skillEntry(),
        'skill://pdf-processing/scripts/evil.py',
        Buffer.from('print(1)', 'utf-8')
      )
    ).toThrow(/not part of the skill's file manifest/);
  });

  it('skips verification for a dynamic skill, which publishes no digests', () => {
    expect(() =>
      verifyAgainstManifest(
        skillEntry({ resources: 'dynamic' }),
        'skill://pdf-processing/anything.md',
        Buffer.from('whatever', 'utf-8')
      )
    ).not.toThrow();
  });
});

describe('getSkill --json', () => {
  /** Route the command's withMcpClient call to a stub client and capture stdout. */
  async function runJson(
    client: Partial<IMcpClient>,
    file?: string
  ): Promise<Record<string, unknown>> {
    vi.mocked(withMcpClient).mockImplementation(async (_target, _options, callback) =>
      callback(client as never, {} as never)
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await getSkill('@s', 'skill://pdf-processing/SKILL.md', file, { outputMode: 'json' });
      expect(log).toHaveBeenCalledTimes(1);
      return JSON.parse(log.mock.calls[0]![0] as string) as Record<string, unknown>;
    } finally {
      log.mockRestore();
    }
  }

  it('emits only the content item that was verified against the manifest', async () => {
    const printed = await runJson({
      getSkill: vi.fn().mockResolvedValue({ skill: skillEntry() }),
      readResource: vi.fn().mockResolvedValue({
        contents: [
          // Not in the manifest, never verified — must not reach the caller.
          { uri: 'skill://pdf-processing/other', text: 'unverified instructions' },
          { uri: 'skill://pdf-processing/SKILL.md', mimeType: 'text/markdown', text: SKILL_MD },
        ],
      }),
    });
    expect(printed.contents).toEqual([
      { uri: 'skill://pdf-processing/SKILL.md', mimeType: 'text/markdown', text: SKILL_MD },
    ]);
    expect(JSON.stringify(printed)).not.toContain('unverified instructions');
  });

  it('re-encodes verified binary content as a blob', async () => {
    // A blob cannot carry frontmatter, so read a supporting file rather than SKILL.md.
    const bytes = Buffer.from([0, 1, 2, 255]);
    const fileUri = 'skill://pdf-processing/templates/form.pdf';
    const entry = skillEntry();
    (entry.resources as SkillResource[]).push({
      uri: fileUri,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      size: bytes.length,
    });
    const printed = await runJson(
      {
        getSkill: vi.fn().mockResolvedValue({ skill: entry }),
        readResource: vi.fn().mockResolvedValue({
          contents: [{ uri: fileUri, mimeType: 'application/pdf', blob: bytes.toString('base64') }],
        }),
      },
      'templates/form.pdf'
    );
    expect(printed.contents).toEqual([
      { uri: fileUri, mimeType: 'application/pdf', blob: bytes.toString('base64') },
    ]);
  });
});

describe('verifyFrontmatter', () => {
  it('accepts a SKILL.md whose frontmatter matches the entry', () => {
    expect(() => verifyFrontmatter(skillEntry(), SKILL_MD)).not.toThrow();
  });

  it('rejects a description that differs from the entry', () => {
    const entry = skillEntry({
      frontmatter: { name: 'pdf-processing', description: 'Something else entirely' },
    });
    expect(() => verifyFrontmatter(entry, SKILL_MD)).toThrow(/description/);
  });

  it('rejects a SKILL.md carrying a field the entry never advertised', () => {
    const withExtra = SKILL_MD.replace(
      'description: Extract, fill, and assemble PDF documents',
      'description: Extract, fill, and assemble PDF documents\nallowed-tools: [Bash]'
    );
    expect(() => verifyFrontmatter(skillEntry(), withExtra)).toThrow(/allowed-tools/);
  });

  it('reports a SKILL.md with no frontmatter block', () => {
    expect(() => verifyFrontmatter(skillEntry(), '# Just markdown\n')).toThrow(
      /could not be parsed/
    );
  });

  it('matches extra frontmatter fields the server passed through verbatim', () => {
    const document = `---
name: pdf-processing
description: Extract, fill, and assemble PDF documents
license: Apache-2.0
metadata:
  version: 2.1.0
---

# PDF processing
`;
    const entry = skillEntry({
      frontmatter: {
        name: 'pdf-processing',
        description: 'Extract, fill, and assemble PDF documents',
        license: 'Apache-2.0',
        metadata: { version: '2.1.0' },
      },
    });
    expect(() => verifyFrontmatter(entry, document)).not.toThrow();
  });
});
