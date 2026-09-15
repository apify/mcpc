/**
 * Result validators for the Skills extension (`io.modelcontextprotocol/skills`).
 *
 * The SDK ships no schemas for `skills/list`, `skills/get` or
 * `resources/directory/read`, so mcpc issues those requests through
 * `client.request()` with the hand-written validators below. They implement the
 * Standard Schema v1 contract the SDK expects — deliberately without pulling in a
 * schema library, which would be a dependency paid on every mcpc invocation.
 *
 * Validation is strict about what the spec makes normative for a skill entry — the
 * `uri`, the `name`/`description` frontmatter, and a `resources` manifest that is
 * either a complete file list or the string `"dynamic"` — because an entry that
 * violates those is one a host "MUST NOT load", and a precise error naming the
 * offending entry is more useful to a server author than a silently dropped skill.
 * The caching hints (`ttlMs`, `cacheScope`) are accepted as optional: they are
 * REQUIRED by the spec but carry no meaning for a one-shot CLI, so a server that
 * omits them still gets its skills listed.
 *
 * Spec: https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/stable/skills.mdx
 */

import type { StandardSchemaV1 } from '@modelcontextprotocol/client';
import type {
  GetSkillResult,
  ListSkillsResult,
  ReadResourceDirectoryResult,
  Skill,
  SkillResource,
} from '../lib/types.js';

/** `sha256:` followed by exactly 64 lowercase hex characters, per the spec. */
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Collects validation problems with the path that produced them. */
class Issues {
  readonly list: { message: string; path: string[] }[] = [];

  add(path: string[], message: string): void {
    this.list.push({ message, path });
  }

  get ok(): boolean {
    return this.list.length === 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build a Standard Schema v1 validator from a plain check function, so
 * `client.request()` can use it as a result schema.
 */
function standardSchema<T>(
  validate: (value: unknown, issues: Issues) => T | undefined
): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'mcpc',
      validate: (value: unknown) => {
        const issues = new Issues();
        const parsed = validate(value, issues);
        if (!issues.ok || parsed === undefined) {
          return {
            issues: issues.ok ? [{ message: 'invalid result', path: [] }] : issues.list,
          };
        }
        return { value: parsed };
      },
    },
  };
}

/** Validate one `SkillResource` (a `{ uri, digest, size }` manifest entry). */
function parseSkillResource(
  value: unknown,
  path: string[],
  issues: Issues
): SkillResource | undefined {
  if (!isRecord(value)) {
    issues.add(path, 'must be an object with uri, digest and size');
    return undefined;
  }
  const { uri, digest, size } = value;
  let valid = true;
  if (typeof uri !== 'string' || uri.length === 0) {
    issues.add([...path, 'uri'], 'must be a non-empty string');
    valid = false;
  }
  if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) {
    issues.add([...path, 'digest'], 'must be "sha256:" followed by 64 lowercase hex characters');
    valid = false;
  }
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
    issues.add([...path, 'size'], 'must be a non-negative integer (bytes)');
    valid = false;
  }
  if (!valid) return undefined;
  return { uri: uri as string, digest: digest as string, size: size as number };
}

/**
 * Validate one `Skill` entry. Unknown fields pass through untouched, so a future
 * revision of the entry shape reaches the caller (and `--json`) intact.
 */
function parseSkill(value: unknown, path: string[], issues: Issues): Skill | undefined {
  if (!isRecord(value)) {
    issues.add(path, 'must be an object');
    return undefined;
  }

  let valid = true;

  const uri = value.uri;
  if (typeof uri !== 'string' || uri.length === 0) {
    issues.add([...path, 'uri'], 'must be a non-empty string (the URI of the skill SKILL.md)');
    valid = false;
  }

  const frontmatter = value.frontmatter;
  if (!isRecord(frontmatter)) {
    issues.add([...path, 'frontmatter'], "must be the SKILL.md's YAML frontmatter as an object");
    valid = false;
  } else {
    if (typeof frontmatter.name !== 'string' || frontmatter.name.length === 0) {
      issues.add([...path, 'frontmatter', 'name'], 'must be a non-empty string');
      valid = false;
    }
    if (typeof frontmatter.description !== 'string') {
      issues.add([...path, 'frontmatter', 'description'], 'must be a string');
      valid = false;
    }
  }

  const rawResources = value.resources;
  let resources: SkillResource[] | 'dynamic' | undefined;
  if (rawResources === 'dynamic') {
    resources = 'dynamic';
  } else if (Array.isArray(rawResources)) {
    const parsed: SkillResource[] = [];
    rawResources.forEach((entry, index) => {
      const file = parseSkillResource(entry, [...path, 'resources', String(index)], issues);
      if (file) parsed.push(file);
    });
    if (parsed.length === rawResources.length) resources = parsed;
    else valid = false;
  } else {
    issues.add(
      [...path, 'resources'],
      'is required, and must be the skill\'s complete file manifest or the string "dynamic"'
    );
    valid = false;
  }

  if (!valid || resources === undefined) return undefined;

  return {
    ...value,
    uri: uri as string,
    frontmatter: frontmatter as Skill['frontmatter'],
    resources,
  };
}

/** Optional `nextCursor` shared by the paginated results below. */
function parseCursor(value: Record<string, unknown>, issues: Issues): string | undefined {
  const cursor = value.nextCursor;
  if (cursor === undefined) return undefined;
  if (typeof cursor !== 'string') {
    issues.add(['nextCursor'], 'must be a string when present');
    return undefined;
  }
  return cursor;
}

/** Result schema for `skills/list`. */
export const ListSkillsResultSchema = standardSchema<ListSkillsResult>((value, issues) => {
  if (!isRecord(value)) {
    issues.add([], 'must be an object with a skills array');
    return undefined;
  }
  if (!Array.isArray(value.skills)) {
    issues.add(['skills'], 'must be an array of skill entries');
    return undefined;
  }

  const skills: Skill[] = [];
  value.skills.forEach((entry, index) => {
    const skill = parseSkill(entry, ['skills', String(index)], issues);
    if (skill) skills.push(skill);
  });
  if (!issues.ok) return undefined;

  const nextCursor = parseCursor(value, issues);
  return {
    ...value,
    skills,
    ...(nextCursor !== undefined && { nextCursor }),
  } as ListSkillsResult;
});

/** Result schema for `skills/get`. */
export const GetSkillResultSchema = standardSchema<GetSkillResult>((value, issues) => {
  if (!isRecord(value)) {
    issues.add([], 'must be an object with a skill entry');
    return undefined;
  }
  const skill = parseSkill(value.skill, ['skill'], issues);
  if (!skill) return undefined;
  return { ...value, skill } as GetSkillResult;
});

/** Result schema for `resources/directory/read`. */
export const ReadResourceDirectoryResultSchema = standardSchema<ReadResourceDirectoryResult>(
  (value, issues) => {
    if (!isRecord(value)) {
      issues.add([], 'must be an object with a resources array');
      return undefined;
    }
    if (!Array.isArray(value.resources)) {
      issues.add(['resources'], "must be an array of the directory's direct children");
      return undefined;
    }
    value.resources.forEach((entry, index) => {
      if (!isRecord(entry) || typeof entry.uri !== 'string' || entry.uri.length === 0) {
        issues.add(['resources', String(index), 'uri'], 'must be a non-empty string');
      }
    });
    if (!issues.ok) return undefined;

    const nextCursor = parseCursor(value, issues);
    return {
      ...value,
      ...(nextCursor !== undefined && { nextCursor }),
    } as ReadResourceDirectoryResult;
  }
);
