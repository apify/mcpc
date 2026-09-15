/**
 * Skills command handlers — the MCP Skills extension
 * (`io.modelcontextprotocol/skills`).
 *
 * A skill is a directory of files, minimally a `SKILL.md` with YAML frontmatter, that a
 * server publishes alongside its tools, resources and prompts. The extension adds two
 * methods on top of the Resources primitive:
 *
 *   - `skills/list` enumerates the skills a server serves. Each entry is a complete
 *     manifest: the skill's verbatim frontmatter plus every file with its SHA-256 digest
 *     and byte size.
 *   - `skills/get` returns that same entry for one skill, named by the URI of its
 *     `SKILL.md`, whether or not the skill appears in the listing.
 *
 * Content itself is read with the ordinary `resources/read`, and a host must verify what
 * it reads against the entry before using it. `skills-get` does exactly that: it fetches
 * the entry, reads the file, and checks size, digest and — for a `SKILL.md` — that the
 * document's frontmatter matches what the entry advertised. Unverified content is never
 * printed, so what an agent reads is what the server published.
 *
 * Spec: https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/stable/skills.mdx
 */

import { createHash } from 'crypto';
import type { CommandOptions, IMcpClient, Skill, SkillResource } from '../../lib/types.js';
import { ServerError, ClientError } from '../../lib/errors.js';
import { fetchAllPages } from '../../lib/utils.js';
import { selectResourceContent } from '../../lib/resource-content.js';
import {
  diffFrontmatter,
  parseSkillDocument,
  FrontmatterParseError,
} from '../../lib/frontmatter.js';
import { withMcpClient } from '../helpers.js';
import { formatOutput, formatSkills, formatSkillDetail } from '../output.js';

/** File every skill directory must contain, and the tail of every skill URI. */
const SKILL_FILE = 'SKILL.md';

/** Matches any absolute URI (`skill://…`, `github://…`), which we pass through as-is. */
const ABSOLUTE_URI = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Turn what the user typed into the URI of a skill's `SKILL.md`.
 *
 * A URI is used as given (with `/SKILL.md` appended when it names the skill's directory
 * instead of the file). A bare name or path is looked up in the server's listing, which
 * is the only way to resolve a skill served under a prefix (`acme/billing/refunds`) or a
 * scheme other than `skill://`. When the listing does not mention it — listings may be
 * empty or partial, and a skill absent from one is still retrievable — the conventional
 * `skill://<name>/SKILL.md` is tried, and `skills/get` has the last word.
 *
 * @internal exported for tests
 */
export async function resolveSkillUri(client: IMcpClient, input: string): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new ClientError('Skill name is required');
  }

  if (ABSOLUTE_URI.test(trimmed)) {
    return trimmed.endsWith(`/${SKILL_FILE}`) ? trimmed : appendSkillFile(trimmed);
  }

  const path = trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!path) {
    throw new ClientError(`Invalid skill name: ${input}`);
  }

  const skills = await listAllSkills(client);
  const matches = skills.filter((skill) => matchesSkill(skill, path));

  if (matches.length === 1) return matches[0]!.uri;
  if (matches.length > 1) {
    // Skill names are labels, not identifiers: two skills under different prefixes may
    // share one. The spec requires disambiguating rather than picking one silently.
    const candidates = matches.map((skill) => `  ${skill.uri}`).join('\n');
    throw new ClientError(
      `"${path}" matches ${matches.length} skills on this server. Re-run with the URI of the one you want:\n${candidates}`
    );
  }

  return `skill://${path}/${SKILL_FILE}`;
}

/** Append `/SKILL.md` to a URI that names a skill directory rather than its file. */
function appendSkillFile(uri: string): string {
  const withoutTrailingSlash = uri.replace(/\/+$/, '');
  const lastSegment = withoutTrailingSlash.slice(withoutTrailingSlash.lastIndexOf('/') + 1);
  // A final segment with a dot is already a file (`…/big.tar.gz`), so leave it alone and
  // let the server say whether it serves a skill there.
  return lastSegment.includes('.') ? uri : `${withoutTrailingSlash}/${SKILL_FILE}`;
}

/** Whether a listed skill answers to the name or path the user typed. */
function matchesSkill(skill: Skill, path: string): boolean {
  if (skill.frontmatter.name === path) return true;
  const skillPath = skillPathOf(skill.uri);
  return skillPath === path;
}

/** The `<skill-path>` of a skill URI: scheme and the `/SKILL.md` suffix removed. */
function skillPathOf(uri: string): string {
  const schemeEnd = uri.indexOf('://');
  const withoutScheme = schemeEnd >= 0 ? uri.slice(schemeEnd + 3) : uri;
  return withoutScheme.replace(new RegExp(`/${SKILL_FILE}$`), '');
}

/** Fetch every page of `skills/list`. */
async function listAllSkills(client: IMcpClient): Promise<Skill[]> {
  return fetchAllPages(
    (cursor) => client.listSkills(cursor),
    (page) => page.skills
  );
}

/**
 * Locate a file in a skill's manifest.
 *
 * The manifest is complete, so a file missing from it is not a file of the skill — the
 * spec treats reading one as a verification failure, not a lookup miss.
 */
function findInManifest(skill: Skill, uri: string): SkillResource | undefined {
  if (skill.resources === 'dynamic') return undefined;
  return skill.resources.find((file) => file.uri === uri);
}

/**
 * Resolve the URI of a file inside a skill, given the path as written in `SKILL.md`
 * (`references/FORMS.md`). Relative references resolve against the skill's root, which is
 * the directory holding `SKILL.md`.
 *
 * @internal exported for tests
 */
export function resolveSkillFileUri(skillUri: string, file: string): string {
  const path = file.trim().replace(/^\.\//, '').replace(/^\/+/, '');
  if (!path) {
    throw new ClientError('Skill file path is empty');
  }
  if (path.split('/').includes('..')) {
    throw new ClientError(`Invalid skill file path: ${file} (".." escapes the skill directory)`);
  }
  if (ABSOLUTE_URI.test(path)) return path;
  const root = skillUri.replace(new RegExp(`/${SKILL_FILE}$`), '');
  return `${root}/${path}`;
}

/** SHA-256 of raw bytes in the `sha256:<hex>` form the extension uses for digests. */
function digestOf(data: Buffer): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

/**
 * Check retrieved bytes against the skill's manifest.
 *
 * A size or digest mismatch means the content is not what the entry described — it may be
 * corrupt, tampered with, or simply stale because the skill changed after the entry was
 * fetched. All three are the same to a client: the content must not be used. Because
 * every `skills-get` fetches a fresh entry, a mismatch here is a real inconsistency on
 * the server rather than a stale cache on this side.
 *
 * @internal exported for tests
 */
export function verifyAgainstManifest(skill: Skill, uri: string, data: Buffer): void {
  if (skill.resources === 'dynamic') return;

  const file = findInManifest(skill, uri);
  if (!file) {
    const listed = skill.resources.map((entry) => `  ${entry.uri}`).join('\n');
    throw new ServerError(
      `${uri} is not part of the skill's file manifest, so its content cannot be verified. ` +
        `The skill lists:\n${listed}`
    );
  }

  if (data.length !== file.size) {
    throw new ServerError(
      `Content of ${uri} does not match the skill's manifest: the entry declares ` +
        `${file.size} bytes, the server returned ${data.length}. The skill may have changed ` +
        `since it was published — re-run the command to fetch the current entry.`
    );
  }

  const actual = digestOf(data);
  if (actual !== file.digest) {
    throw new ServerError(
      `Content of ${uri} does not match the digest in the skill's manifest ` +
        `(expected ${file.digest}, got ${actual}). The content was not used. The skill may ` +
        `have changed since it was published — re-run the command to fetch the current entry.`
    );
  }
}

/**
 * Check that a fetched `SKILL.md`'s own frontmatter matches the frontmatter the server
 * published in the skill's entry, so that what a listing describes is what an agent
 * actually reads.
 *
 * @internal exported for tests
 */
export function verifyFrontmatter(skill: Skill, text: string): void {
  let fields: Record<string, unknown>;
  try {
    fields = parseSkillDocument(text).frontmatter;
  } catch (error) {
    if (error instanceof FrontmatterParseError) {
      throw new ServerError(
        `Frontmatter of ${skill.uri} could not be parsed, so it cannot be checked against ` +
          `the skill's entry: ${error.message}`
      );
    }
    throw error;
  }

  const differing = diffFrontmatter(fields, skill.frontmatter);
  if (differing.length > 0) {
    throw new ServerError(
      `Frontmatter of ${skill.uri} does not match the skill's entry ` +
        `(differing ${differing.length === 1 ? 'field' : 'fields'}: ${differing.join(', ')}). ` +
        `The content was not used, since a skill must be what its entry describes.`
    );
  }
}

/**
 * `skills-list` — list the skills the server serves.
 */
export async function listSkills(target: string, options: CommandOptions): Promise<void> {
  await withMcpClient(target, options, async (client) => {
    const skills = await listAllSkills(client);

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
 * `skills-get <skill> [file]` — read a skill's `SKILL.md`, or one of its supporting
 * files, verified against the skill's entry.
 *
 * With `--raw`, prints just the file's text (suitable for piping into a file or a model).
 */
export async function getSkill(
  target: string,
  name: string,
  file: string | undefined,
  options: CommandOptions & { raw?: boolean }
): Promise<void> {
  // --raw output must stay bare for piping — suppress the [session] prefix line
  const clientOptions = options.raw ? { ...options, hideTarget: true } : options;

  await withMcpClient(target, clientOptions, async (client) => {
    const skillUri = await resolveSkillUri(client, name);
    const { skill } = await client.getSkill(skillUri);

    // `skills/get` answers for the skill it serves at that URI; use the URI it reports
    // back so the manifest lookups below compare like with like.
    const targetUri = file ? resolveSkillFileUri(skill.uri, file) : skill.uri;

    const result = await client.readResource(targetUri);
    const content = selectResourceContent(result, targetUri);

    verifyAgainstManifest(skill, targetUri, content.data);
    if (targetUri === skill.uri) {
      // The bytes are the document whatever the server wrapped them in, and a SKILL.md
      // whose frontmatter cannot be read is one that cannot be checked against its entry.
      verifyFrontmatter(skill, content.data.toString('utf-8'));
    }

    if (options.outputMode === 'json') {
      console.log(formatOutput({ skill, contents: result.contents }, 'json'));
      return;
    }

    if (options.raw) {
      if (content.binary) {
        if (process.stdout.isTTY) {
          throw new ClientError(
            `Binary content (${content.mimeType || 'unknown type'}, ${content.data.length} bytes) would mess up the terminal.\n` +
              `Redirect stdout: mcpc ${target} skills-get ${name}${file ? ` ${file}` : ''} --raw > file`
          );
        }
        process.stdout.write(content.data);
      } else {
        console.log(content.data.toString('utf-8'));
      }
      return;
    }

    console.log(
      formatSkillDetail(skill, targetUri, content, {
        sessionName: target,
        ...(options.maxChars && { maxChars: options.maxChars }),
      })
    );
  });
}
