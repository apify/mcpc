/**
 * Tests for the Skills extension result validators. They are what stands between a
 * malformed `skills/list` entry and a host acting on a skill the spec says it must not
 * load, so the rejections matter as much as the acceptances.
 */

import {
  ListSkillsResultSchema,
  GetSkillResultSchema,
  ReadResourceDirectoryResultSchema,
} from '../../../src/core/skills-schema.js';
import type { StandardSchemaV1 } from '@modelcontextprotocol/client';

const DIGEST = `sha256:${'a'.repeat(64)}`;

function validate<T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown
): StandardSchemaV1.Result<T> {
  return schema['~standard'].validate(value) as StandardSchemaV1.Result<T>;
}

const ENTRY = {
  uri: 'skill://git-workflow/SKILL.md',
  frontmatter: { name: 'git-workflow', description: 'Follow the team conventions' },
  resources: [{ uri: 'skill://git-workflow/SKILL.md', digest: DIGEST, size: 2314 }],
};

describe('ListSkillsResultSchema', () => {
  it('accepts a listing and keeps the caching hints', () => {
    const result = validate(ListSkillsResultSchema, {
      resultType: 'complete',
      skills: [ENTRY],
      ttlMs: 300000,
      cacheScope: 'public',
    });
    expect(result.issues).toBeUndefined();
    expect(result.value?.skills).toHaveLength(1);
    expect(result.value?.ttlMs).toBe(300000);
    expect(result.value?.cacheScope).toBe('public');
  });

  it('accepts an empty listing — that is not proof a server has no skills', () => {
    const result = validate(ListSkillsResultSchema, { skills: [] });
    expect(result.issues).toBeUndefined();
    expect(result.value?.skills).toEqual([]);
  });

  it('accepts a listing without the caching hints', () => {
    const result = validate(ListSkillsResultSchema, { skills: [ENTRY] });
    expect(result.issues).toBeUndefined();
  });

  it('accepts a dynamic skill', () => {
    const result = validate(ListSkillsResultSchema, {
      skills: [{ ...ENTRY, resources: 'dynamic' }],
    });
    expect(result.issues).toBeUndefined();
    expect(result.value?.skills[0]?.resources).toBe('dynamic');
  });

  it('keeps the cursor and any fields a future revision adds', () => {
    const result = validate(ListSkillsResultSchema, {
      skills: [{ ...ENTRY, futureField: 42 }],
      nextCursor: 'page-2',
    });
    expect(result.value?.nextCursor).toBe('page-2');
    expect((result.value?.skills[0] as Record<string, unknown>).futureField).toBe(42);
  });

  it('rejects an entry with no resources manifest', () => {
    const { resources: _dropped, ...withoutManifest } = ENTRY;
    const result = validate(ListSkillsResultSchema, { skills: [withoutManifest] });
    expect(result.issues?.[0]?.path).toEqual(['skills', '0', 'resources']);
  });

  it('rejects a manifest digest that is not sha256:<64 hex>', () => {
    const result = validate(ListSkillsResultSchema, {
      skills: [{ ...ENTRY, resources: [{ uri: ENTRY.uri, digest: 'md5:abc', size: 1 }] }],
    });
    expect(result.issues?.[0]?.path).toEqual(['skills', '0', 'resources', '0', 'digest']);
  });

  it('rejects a manifest entry missing its size', () => {
    const result = validate(ListSkillsResultSchema, {
      skills: [{ ...ENTRY, resources: [{ uri: ENTRY.uri, digest: DIGEST }] }],
    });
    expect(result.issues?.[0]?.path).toEqual(['skills', '0', 'resources', '0', 'size']);
  });

  it('rejects an entry whose frontmatter lacks name or description', () => {
    const result = validate(ListSkillsResultSchema, {
      skills: [{ ...ENTRY, frontmatter: { name: 'git-workflow' } }],
    });
    expect(result.issues?.[0]?.path).toEqual(['skills', '0', 'frontmatter', 'description']);
  });

  it('rejects a result with no skills array', () => {
    expect(validate(ListSkillsResultSchema, { resultType: 'complete' }).issues).toBeDefined();
  });
});

describe('GetSkillResultSchema', () => {
  it('accepts a single entry', () => {
    const result = validate(GetSkillResultSchema, { skill: ENTRY, ttlMs: 1000 });
    expect(result.issues).toBeUndefined();
    expect(result.value?.skill.frontmatter.name).toBe('git-workflow');
  });

  it('rejects a result with no skill', () => {
    expect(validate(GetSkillResultSchema, { skills: [ENTRY] }).issues).toBeDefined();
  });
});

describe('ReadResourceDirectoryResultSchema', () => {
  it('accepts a directory listing', () => {
    const result = validate(ReadResourceDirectoryResultSchema, {
      resources: [
        { uri: 'skill://pdf/templates/invoice.md', name: 'invoice.md', mimeType: 'text/markdown' },
        { uri: 'skill://pdf/templates/regional', name: 'regional', mimeType: 'inode/directory' },
      ],
      nextCursor: 'page-2',
    });
    expect(result.issues).toBeUndefined();
    expect(result.value?.resources).toHaveLength(2);
    expect(result.value?.nextCursor).toBe('page-2');
  });

  it('accepts an empty directory', () => {
    expect(validate(ReadResourceDirectoryResultSchema, { resources: [] }).issues).toBeUndefined();
  });

  it('rejects a child without a URI', () => {
    const result = validate(ReadResourceDirectoryResultSchema, {
      resources: [{ name: 'invoice.md' }],
    });
    expect(result.issues?.[0]?.path).toEqual(['resources', '0', 'uri']);
  });
});
