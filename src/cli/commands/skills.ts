/**
 * Skills command handlers — implements the experimental MCP skills extension
 * (SEP-2640: io.modelcontextprotocol/skills).
 *
 * Skills are not a new MCP primitive — they are a URI convention layered on
 * top of the existing Resources primitive:
 *
 *   - Each skill lives at `skill://<skill-path>/SKILL.md` (markdown + YAML
 *     frontmatter), optionally with supporting files under the same prefix.
 *   - Servers MAY expose a discovery index at `skill://index.json` listing
 *     `{ name, description, type, url }` entries.
 *   - Servers MAY advertise the extension via
 *     `capabilities.extensions["io.modelcontextprotocol/skills"]`.
 *
 * These commands are sugar on top of `resources-read`, so they work against
 * any compliant server without requiring server-side awareness of mcpc.
 *
 * Spec: https://github.com/modelcontextprotocol/experimental-ext-skills
 */

import type { CommandOptions, IMcpClient } from '../../lib/types.js';
import type { ReadResourceResult, Resource } from '@modelcontextprotocol/sdk/types.js';
import { ServerError, ClientError } from '../../lib/errors.js';
import { withMcpClient } from '../helpers.js';
import { formatOutput, formatSkills, formatSkillDetail } from '../output.js';

/**
 * URI of the well-known skills discovery index.
 */
export const SKILLS_INDEX_URI = 'skill://index.json';

/**
 * Capability key under `capabilities.extensions` advertising skills support.
 */
export const SKILLS_EXTENSION_KEY = 'io.modelcontextprotocol/skills';

/**
 * Single entry in the skills discovery index. Mirrors the Agent Skills
 * discovery schema with mcpc-relevant fields kept.
 *
 * Per SEP-2640, `name` is required for `type: "skill-md"` entries but
 * optional for `type: "mcp-resource-template"` (parameterized namespaces
 * may not have a single concrete name). When `name` is absent, mcpc
 * derives a display name from the URL.
 */
export interface Skill {
  /** Skill name. Derived from URL for nameless `mcp-resource-template` entries. */
  name: string;
  /** Human-readable description. */
  description: string;
  /**
   * Entry type, either `"skill-md"` (concrete skill) or
   * `"mcp-resource-template"` (parameterized namespace).
   */
  type?: string;
  /** MCP resource URI of the skill's `SKILL.md`, or an RFC 6570 URI template. */
  url: string;
}

interface RawIndexEntry {
  name?: unknown;
  description?: unknown;
  type?: unknown;
  url?: unknown;
}

interface RawIndex {
  skills?: unknown;
}

/**
 * Extract the readable text from a `ReadResourceResult`. Skills resources are
 * always text (`text/markdown` or `application/json`), so we ignore blobs.
 *
 * @internal exported for tests
 */
export function extractTextContent(result: ReadResourceResult): string | undefined {
  for (const item of result.contents) {
    if ('text' in item && typeof item.text === 'string') {
      return item.text;
    }
  }
  return undefined;
}

/**
 * Parse and validate a discovery index into a list of `Skill` objects. Drops
 * malformed entries silently rather than failing — the spec instructs hosts
 * to be permissive about what they accept.
 *
 * @internal exported for tests
 */
export function parseIndex(text: string): Skill[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ServerError(
      `Skills index at ${SKILLS_INDEX_URI} is not valid JSON: ${(err as Error).message}`
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new ServerError(
      `Skills index at ${SKILLS_INDEX_URI} is not a JSON object (got ${typeof parsed})`
    );
  }

  const raw = (parsed as RawIndex).skills;
  if (!Array.isArray(raw)) {
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as RawIndexEntry;
    if (typeof e.url !== 'string') continue;

    // SEP-2640 defines three valid `type` values. The spec says clients
    // SHOULD skip entries with an unrecognized `type`. Treat an absent
    // `type` as `skill-md` for backwards compatibility with older drafts.
    const type = typeof e.type === 'string' ? e.type : 'skill-md';
    if (type !== 'skill-md' && type !== 'archive' && type !== 'mcp-resource-template') {
      continue;
    }

    // `name` is required for `skill-md` and `archive` entries, and optional
    // for `mcp-resource-template` (parameterized namespaces).
    const isTemplate = type === 'mcp-resource-template';
    let name: string;
    if (typeof e.name === 'string' && e.name.length > 0) {
      name = e.name;
    } else if (isTemplate) {
      // Derive a display name from the template URL for nameless templates.
      name = displayNameFromUrl(e.url);
    } else {
      // skill-md / archive without a name violates the spec — drop silently.
      continue;
    }

    skills.push({
      name,
      description: typeof e.description === 'string' ? e.description : '',
      ...(type !== undefined && { type }),
      url: e.url,
    });
  }

  return skills;
}

/**
 * Derive a display name from an index URL when the entry has no `name` field
 * (e.g. an `mcp-resource-template` entry). Picks the last meaningful segment
 * before `SKILL.md` or the last segment of the path.
 */
function displayNameFromUrl(url: string): string {
  // Strip scheme + authority; we only care about the path.
  const schemeEnd = url.indexOf('://');
  const path = schemeEnd >= 0 ? url.slice(schemeEnd + 3) : url;
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return url;
  // If the URL ends with SKILL.md, the segment before it is the skill name.
  if (parts[parts.length - 1] === 'SKILL.md' && parts.length >= 2) {
    return parts[parts.length - 2] as string;
  }
  return parts[parts.length - 1] as string;
}

/**
 * Fallback discovery: scan the server's resource list for SKILL.md files
 * under any `skill://...` prefix. Used when the well-known index is absent.
 *
 * @internal exported for tests
 */
export function skillsFromResources(resources: Resource[]): Skill[] {
  // Match `skill://<one-or-more-segments>/SKILL.md`
  const pattern = /^skill:\/\/((?:[^/]+\/)*[^/]+)\/SKILL\.md$/;

  const skills: Skill[] = [];
  for (const resource of resources) {
    const m = pattern.exec(resource.uri);
    if (!m || !m[1]) continue;
    // The skill name is the *final* path segment per SEP-2640.
    const path = m[1];
    const lastSlash = path.lastIndexOf('/');
    const name = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;

    skills.push({
      name: resource.name || name,
      description: resource.description || '',
      type: 'skill-md',
      url: resource.uri,
    });
  }
  return skills;
}

/**
 * Discover skills exposed by the server.
 *
 * Strategy:
 * 1. Try to read `skill://index.json` and parse its `skills` array.
 * 2. If the index is missing (404-style errors), fall back to listing
 *    resources and matching `skill://*​/SKILL.md` URIs.
 *
 * The spec requires that hosts MUST NOT treat an absent index as proof a
 * server has no skills, hence the fallback.
 *
 * @internal exported for tests
 */
export async function discoverSkills(client: IMcpClient): Promise<Skill[]> {
  try {
    const indexResult = await client.readResource(SKILLS_INDEX_URI);
    const text = extractTextContent(indexResult);
    if (text !== undefined) {
      return parseIndex(text);
    }
  } catch {
    // Index not present — fall through to resource scan.
  }

  // Fallback: scan all resources, matching `skill://*​/SKILL.md`.
  const all: Resource[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listResources(cursor);
    all.push(...page.resources);
    cursor = page.nextCursor;
  } while (cursor);

  return skillsFromResources(all);
}

/**
 * Resolve a user-provided identifier into a `SKILL.md` URI.
 *
 * Accepts:
 *   - A bare name (`git-workflow`) → `skill://git-workflow/SKILL.md`
 *   - A multi-segment path (`acme/billing/refunds`) → `skill://acme/billing/refunds/SKILL.md`
 *   - A full `skill://...` URI → returned as-is, with `/SKILL.md` appended
 *     when the URI does not already point at a file.
 */
export function resolveSkillUri(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new ClientError('Skill name is required');
  }

  if (trimmed.startsWith('skill://')) {
    // Already a URI. If it points at a directory, append SKILL.md.
    const rest = trimmed.slice('skill://'.length);
    const lastSegment = rest.slice(rest.lastIndexOf('/') + 1);
    if (lastSegment.includes('.')) {
      return trimmed;
    }
    return trimmed.endsWith('/') ? `${trimmed}SKILL.md` : `${trimmed}/SKILL.md`;
  }

  // Strip surrounding slashes; allow nested paths.
  const path = trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!path) {
    throw new ClientError(`Invalid skill name: ${input}`);
  }
  return `skill://${path}/SKILL.md`;
}

/**
 * `skills-list` — discover and list skills exposed by the server.
 *
 * Tries the well-known `skill://index.json` index first; falls back to
 * scanning resources for `skill://*​/SKILL.md` URIs.
 */
export async function listSkills(target: string, options: CommandOptions): Promise<void> {
  await withMcpClient(target, options, async (client) => {
    const skills = await discoverSkills(client);

    if (options.outputMode === 'json') {
      console.log(formatOutput(skills, 'json'));
      return;
    }

    console.log(
      formatSkills(skills, target, {
        ...(options.maxChars && { maxChars: options.maxChars }),
      })
    );
  });
}

/**
 * `skills-get <name>` — read a skill's SKILL.md.
 *
 * Resolves `<name>` to `skill://<name>/SKILL.md` (or accepts a full URI),
 * reads it via `resources/read`, and renders the markdown.
 *
 * With `--raw`, prints just the SKILL.md text (suitable for piping).
 */
export async function getSkill(
  target: string,
  name: string,
  options: CommandOptions & { raw?: boolean }
): Promise<void> {
  const uri = resolveSkillUri(name);

  await withMcpClient(target, options, async (client) => {
    const result = await client.readResource(uri);

    if (options.outputMode === 'json') {
      console.log(formatOutput(result, 'json'));
      return;
    }

    if (options.raw) {
      const text = extractTextContent(result);
      if (text !== undefined) {
        console.log(text);
        return;
      }
      // No text content — fall through to formatted view.
    }

    console.log(
      formatSkillDetail(uri, result, {
        ...(options.maxChars && { maxChars: options.maxChars }),
      })
    );
  });
}
