/**
 * Grep command handler - search tools, resources, prompts, and instructions
 */

import chalk from 'chalk';
import type { Tool, Resource, Prompt, CommandOptions, SessionData } from '../../lib/types.js';
import { ClientError } from '../../lib/errors.js';
import { isProcessAlive } from '../../lib/utils.js';
import { consolidateSessions } from '../../lib/sessions.js';
import { reconnectCrashedSessions } from '../../lib/bridge-manager.js';
import { withSessionClient } from '../../lib/session-client.js';
import { withMcpClient } from '../helpers.js';
import { formatJson, formatToolLine, inBackticks, theme } from '../output.js';
import type { IMcpClient } from '../../lib/types.js';
import { getBridgeStatus, formatBridgeStatus } from './sessions.js';

export interface GrepOptions extends CommandOptions {
  tools?: boolean | undefined;
  resources?: boolean | undefined;
  prompts?: boolean | undefined;
  instructions?: boolean | undefined;
  regex?: boolean | undefined;
  caseSensitive?: boolean | undefined;
  maxResults?: number | undefined;
}

interface GrepResult {
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
  /** false when no match, snippet string when matched */
  instructions: string | false;
}

interface SessionGrepResult {
  name: string;
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
  instructions: string | false;
}

interface SessionGrepError {
  name: string;
  error: string;
}

interface SessionGrepSkipped {
  name: string;
  status: string;
}

/**
 * Build a match function from the pattern and options
 */
function buildMatcher(pattern: string, options: GrepOptions): (text: string) => boolean {
  if (options.regex) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, options.caseSensitive ? '' : 'i');
    } catch (err) {
      throw new ClientError(
        `Invalid regex pattern: ${pattern}\n${err instanceof Error ? err.message : String(err)}`
      );
    }
    return (text: string) => re.test(text);
  }

  if (options.caseSensitive) {
    return (text: string) => text.includes(pattern);
  }

  const lowerPattern = pattern.toLowerCase();
  return (text: string) => text.toLowerCase().includes(lowerPattern);
}

/**
 * Determine which types to search based on flags.
 * If no type flags are given, defaults to tools and instructions.
 * If any type flag is given, search exactly the specified types.
 */
function getSearchTypes(options: GrepOptions): {
  searchTools: boolean;
  searchResources: boolean;
  searchPrompts: boolean;
  searchInstructions: boolean;
} {
  const anyFilter = options.tools || options.resources || options.prompts || options.instructions;
  return {
    searchTools: anyFilter ? !!options.tools : true,
    searchResources: !!options.resources,
    searchPrompts: !!options.prompts,
    searchInstructions: anyFilter ? !!options.instructions : true,
  };
}

/**
 * Build the searchable text for a tool, including session context.
 * Format: "@session/tool-name <JSON schema>"
 */
function buildToolSearchText(tool: Tool, sessionName: string): string {
  return `${sessionName}/${tool.name} ${JSON.stringify(tool, null, 2)}`;
}

/**
 * Build the searchable text for a resource, including session context.
 * Format: "@session/resource-uri <JSON schema>"
 */
function buildResourceSearchText(resource: Resource, sessionName: string): string {
  return `${sessionName}/${resource.uri} ${JSON.stringify(resource, null, 2)}`;
}

/**
 * Build the searchable text for a prompt, including session context.
 * Format: "@session/prompt-name <JSON schema>"
 */
function buildPromptSearchText(prompt: Prompt, sessionName: string): string {
  return `${sessionName}/${prompt.name} ${JSON.stringify(prompt, null, 2)}`;
}

/**
 * Build the searchable text for server instructions, including session context.
 * Format: "@session <instructions text>"
 */
function buildInstructionsSearchText(instructions: string, sessionName: string): string {
  return `${sessionName} ${instructions}`;
}

/**
 * Extract a short snippet from instructions text around the first match.
 * The total snippet is capped at pattern.length + 70 characters (minimum 70).
 * When the match is short and near the start or end, unused context budget
 * from one side is redistributed to the other. When the match itself is very
 * long (e.g. `.*`), the snippet is truncated from the beginning of the text.
 * Ellipsis is added when the snippet doesn't reach the start/end.
 * Whitespace is normalized to single spaces.
 */
export function extractInstructionsSnippet(
  instructions: string,
  pattern: string,
  options: { regex?: boolean | undefined; caseSensitive?: boolean | undefined }
): string | false {
  // Normalize whitespace for display
  const normalized = instructions.replace(/\s+/g, ' ').trim();

  let matchStart: number;
  let matchEnd: number;

  if (options.regex) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, options.caseSensitive ? '' : 'i');
    } catch {
      return false;
    }
    const match = re.exec(normalized);
    if (!match) return false;
    matchStart = match.index;
    matchEnd = matchStart + match[0].length;
  } else {
    const haystack = options.caseSensitive ? normalized : normalized.toLowerCase();
    const needle = options.caseSensitive ? pattern : pattern.toLowerCase();
    matchStart = haystack.indexOf(needle);
    if (matchStart === -1) return false;
    matchEnd = matchStart + needle.length;
  }

  const matchLen = matchEnd - matchStart;
  const maxSnippet = Math.max(70, pattern.length + 70);

  // When the match itself is longer than the budget, just show the beginning of the text
  if (matchLen >= maxSnippet) {
    if (normalized.length <= maxSnippet) return normalized;
    // Snap to word boundary
    let end = maxSnippet;
    const spacePos = normalized.lastIndexOf(' ', end);
    if (spacePos > maxSnippet * 0.5) end = spacePos;
    return normalized.slice(0, end) + '\u2026';
  }

  // Total context budget (chars around the match, excluding the match itself).
  // When the match is near start/end, unused budget from one side is given to the other.
  const totalContext = maxSnippet - matchLen;
  const availBefore = matchStart;
  const availAfter = normalized.length - matchEnd;

  let ctxBefore: number;
  let ctxAfter: number;
  if (availBefore + availAfter <= totalContext) {
    // Entire text fits within the budget
    ctxBefore = availBefore;
    ctxAfter = availAfter;
  } else if (availBefore <= totalContext / 2) {
    // Near start — give leftover to the right
    ctxBefore = availBefore;
    ctxAfter = Math.min(availAfter, totalContext - ctxBefore);
  } else if (availAfter <= totalContext / 2) {
    // Near end — give leftover to the left
    ctxAfter = availAfter;
    ctxBefore = Math.min(availBefore, totalContext - ctxAfter);
  } else {
    // Middle — split evenly
    ctxBefore = Math.floor(totalContext / 2);
    ctxAfter = totalContext - ctxBefore;
  }

  let snippetStart = matchStart - ctxBefore;
  let snippetEnd = matchEnd + ctxAfter;

  // Snap to word boundaries if possible (don't cut mid-word)
  if (snippetStart > 0) {
    const spacePos = normalized.indexOf(' ', snippetStart);
    if (spacePos !== -1 && spacePos < matchStart) {
      snippetStart = spacePos + 1;
    }
  }
  if (snippetEnd < normalized.length) {
    const spacePos = normalized.lastIndexOf(' ', snippetEnd);
    if (spacePos !== -1 && spacePos > matchEnd) {
      snippetEnd = spacePos;
    }
  }

  let snippet = normalized.slice(snippetStart, snippetEnd);
  if (snippetStart > 0) snippet = '\u2026' + snippet;
  if (snippetEnd < normalized.length) snippet = snippet + '\u2026';

  return snippet;
}

/**
 * Highlight the first match of a pattern in a text string using chalk.bold.underline.
 */
function highlightMatch(
  text: string,
  pattern: string,
  options: { regex?: boolean | undefined; caseSensitive?: boolean | undefined }
): string {
  if (options.regex) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, options.caseSensitive ? '' : 'i');
    } catch {
      return text;
    }
    return text.replace(re, (m) => chalk.bold.underline(m));
  }

  const haystack = options.caseSensitive ? text : text.toLowerCase();
  const needle = options.caseSensitive ? pattern : pattern.toLowerCase();
  const idx = haystack.indexOf(needle);
  if (idx === -1) return text;

  const before = text.slice(0, idx);
  const matched = text.slice(idx, idx + needle.length);
  const after = text.slice(idx + needle.length);
  return before + chalk.bold.underline(matched) + after;
}

/**
 * Search a single MCP client for matching items.
 * Respects server capabilities — only fetches types the server supports.
 */
async function searchClient(
  client: IMcpClient,
  pattern: string,
  matcher: (text: string) => boolean,
  options: GrepOptions,
  sessionName: string = ''
): Promise<GrepResult> {
  const { searchTools, searchResources, searchPrompts, searchInstructions } =
    getSearchTypes(options);

  // Always fetch server details (needed for capabilities check and instructions search)
  const serverDetails = await client.getServerDetails();
  const capabilities = serverDetails.capabilities;

  // Only fetch types that are both requested AND supported by the server
  const canListTools = searchTools && !!capabilities?.tools;
  const canListResources = searchResources && !!capabilities?.resources;
  const canListPrompts = searchPrompts && !!capabilities?.prompts;

  // Fetch all lists in parallel (only the types we need and the server supports)
  const [toolsResult, resourcesResult, promptsResult] = await Promise.all([
    canListTools ? client.listAllTools() : null,
    canListResources ? fetchAllResources(client) : null,
    canListPrompts ? fetchAllPrompts(client) : null,
  ]);

  // Filter tools
  const matchedTools = (toolsResult?.tools ?? []).filter((t) =>
    matcher(buildToolSearchText(t, sessionName))
  );

  // Filter resources
  const matchedResources = (resourcesResult ?? []).filter((r) =>
    matcher(buildResourceSearchText(r, sessionName))
  );

  // Filter prompts
  const matchedPrompts = (promptsResult ?? []).filter((p) =>
    matcher(buildPromptSearchText(p, sessionName))
  );

  // Match instructions — produce a snippet if matched
  const instructionsText = searchInstructions ? serverDetails.instructions : undefined;
  let matchedInstructions: string | false = false;
  if (instructionsText && matcher(buildInstructionsSearchText(instructionsText, sessionName))) {
    const snippet = extractInstructionsSnippet(instructionsText, pattern, options);
    // Fallback: if snippet extraction fails (e.g. match was on session name prefix), show truncated text
    matchedInstructions =
      snippet || instructionsText.replace(/\s+/g, ' ').trim().slice(0, 90) + '…';
  }

  return {
    tools: matchedTools,
    resources: matchedResources,
    prompts: matchedPrompts,
    instructions: matchedInstructions,
  };
}

/**
 * Fetch all resources with pagination
 */
async function fetchAllResources(client: IMcpClient): Promise<Resource[]> {
  const all: Resource[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.listResources(cursor);
    all.push(...result.resources);
    cursor = result.nextCursor;
  } while (cursor);
  return all;
}

/**
 * Fetch all prompts with pagination
 */
async function fetchAllPrompts(client: IMcpClient): Promise<Prompt[]> {
  const all: Prompt[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.listPrompts(cursor);
    all.push(...result.prompts);
    cursor = result.nextCursor;
  } while (cursor);
  return all;
}

// ─── Output formatting ──────────────────────────────────────────────

interface MatchCounts {
  tools: number;
  resources: number;
  prompts: number;
}

function countMatches(result: GrepResult): number {
  return (
    result.tools.length +
    result.resources.length +
    result.prompts.length +
    (result.instructions ? 1 : 0)
  );
}

function countMatchesByType(result: GrepResult): MatchCounts {
  return {
    tools: result.tools.length,
    resources: result.resources.length,
    prompts: result.prompts.length,
  };
}

function sumMatchesByType(results: GrepResult[]): MatchCounts {
  return results.reduce(
    (acc, r) => ({
      tools: acc.tools + r.tools.length,
      resources: acc.resources + r.resources.length,
      prompts: acc.prompts + r.prompts.length,
    }),
    { tools: 0, resources: 0, prompts: 0 }
  );
}

/**
 * Truncate a GrepResult to at most `limit` total items (tools first, then resources, then prompts).
 * Instructions count as 1 item if matched. Returns the truncated result and how many items were dropped.
 */
function truncateResult(
  result: GrepResult,
  limit: number
): { result: GrepResult; truncated: number } {
  const total = countMatches(result);
  if (total <= limit) return { result, truncated: 0 };

  let remaining = limit;

  // Instructions always come first (it's just 1 item)
  const instructions = result.instructions && remaining > 0 ? result.instructions : false;
  if (instructions) remaining--;

  const tools = result.tools.slice(0, remaining);
  remaining -= tools.length;
  const resources = result.resources.slice(0, remaining);
  remaining -= resources.length;
  const prompts = result.prompts.slice(0, remaining);

  return {
    result: { tools, resources, prompts, instructions },
    truncated: total - limit,
  };
}

/**
 * Format a single resource as a compact bullet line
 */
function formatResourceLine(resource: Resource): string {
  const bullet = chalk.dim('*');
  return `${bullet} ${inBackticks(resource.uri)}`;
}

/**
 * Format a single prompt as a compact bullet line
 */
function formatPromptLine(prompt: Prompt): string {
  const bullet = chalk.dim('*');
  return `${bullet} ${inBackticks(prompt.name)}`;
}

/**
 * Format a grep result section (tools/resources/prompts) with a type header
 */
function formatResultSection(
  label: string,
  items: unknown[],
  formatLine: (item: never) => string,
  indent: string
): string[] {
  if (items.length === 0) return [];
  const lines: string[] = [];
  lines.push(`${indent}${chalk.bold(`${label} (${items.length}):`)}`);
  for (const item of items) {
    lines.push(`${indent}  ${formatLine(item as never)}`);
  }
  return lines;
}

/**
 * Format human output for a single session's grep results
 */
function formatGrepResultHuman(
  result: GrepResult,
  indent: string = '',
  pattern?: string,
  options?: { regex?: boolean | undefined; caseSensitive?: boolean | undefined }
): string[] {
  const lines: string[] = [];
  if (result.instructions) {
    const snippet =
      pattern && options
        ? highlightMatch(result.instructions, pattern, options)
        : result.instructions;
    lines.push(`${indent}${chalk.bold('Instructions:')} ${chalk.dim('````' + snippet + '````')}`);
  }
  lines.push(
    ...formatResultSection('Tools', result.tools, formatToolLine as (item: never) => string, indent)
  );
  lines.push(
    ...formatResultSection(
      'Resources',
      result.resources,
      formatResourceLine as (item: never) => string,
      indent
    )
  );
  lines.push(
    ...formatResultSection(
      'Prompts',
      result.prompts,
      formatPromptLine as (item: never) => string,
      indent
    )
  );
  return lines;
}

// ─── Single-session grep ─────────────────────────────────────────────

/**
 * Search a single session for matching tools, resources, and prompts.
 * Returns exit code (0 = matches found, 1 = no matches).
 */
export async function grepSession(
  session: string,
  pattern: string,
  options: GrepOptions
): Promise<number> {
  const matcher = buildMatcher(pattern, options);

  const sessionRef = session.startsWith('@') ? session : `@${session}`;

  return await withMcpClient(session, options, async (client) => {
    const fullResult = await searchClient(client, pattern, matcher, options, sessionRef);
    const total = countMatches(fullResult);

    const { result, truncated } =
      options.maxResults != null
        ? truncateResult(fullResult, options.maxResults)
        : { result: fullResult, truncated: 0 };

    if (options.outputMode === 'json') {
      const matchCounts = countMatchesByType(fullResult);
      const jsonOutput: Record<string, unknown> = {
        sessions: [
          {
            name: sessionRef,
            status: 'live',
            instructions: result.instructions,
            tools: result.tools,
            resources: result.resources,
            prompts: result.prompts,
          },
        ],
        totalMatches: {
          ...matchCounts,
          ...(truncated > 0 ? { truncated } : {}),
        },
      };
      console.log(formatJson(jsonOutput));
    } else {
      if (total === 0) {
        console.log('No matches found.');
      } else {
        const lines = formatGrepResultHuman(result, '', pattern, options);
        lines.push('');
        const suffix = truncated > 0 ? ` (showing ${countMatches(result)})` : '';
        lines.push(chalk.dim(`${total} ${total === 1 ? 'match' : 'matches'}${suffix}.`));
        console.log(lines.join('\n'));
      }
    }

    return total > 0 ? 0 : 1;
  });
}

// ─── Multi-session grep ──────────────────────────────────────────────

/**
 * Format a skipped (unavailable) session line for human output.
 * Example: "@testx ○ crashed"
 */
function formatSkippedSession(skipped: SessionGrepSkipped): string {
  const { dot, text } = formatBridgeStatus(skipped.status as 'crashed');
  return `${theme.cyan(skipped.name)} ${dot} ${text}`;
}

/**
 * Determine if a session is queryable (bridge process alive)
 */
function isSessionQueryable(session: SessionData): boolean {
  return !!session.pid && isProcessAlive(session.pid);
}

/**
 * Search all sessions for matching tools, resources, and prompts.
 * Shows unavailable sessions with their status.
 * Returns exit code (0 = matches found, 1 = no matches).
 */
export async function grepAllSessions(pattern: string, options: GrepOptions): Promise<number> {
  const matcher = buildMatcher(pattern, options);

  // Load all sessions
  const consolidateResult = await consolidateSessions(false);
  const allSessionEntries = Object.values(consolidateResult.sessions);

  // Auto-reconnect crashed bridges in the background (fire-and-forget)
  reconnectCrashedSessions(consolidateResult.sessionsToRestart);

  if (allSessionEntries.length === 0) {
    if (options.outputMode === 'json') {
      console.log(
        formatJson({ sessions: [], totalMatches: { tools: 0, resources: 0, prompts: 0 } })
      );
    } else {
      console.log(chalk.bold('No active sessions.'));
      console.log(chalk.dim('  \u21B3 run: mcpc connect mcp.example.com @test'));
    }
    return 1;
  }

  // Ensure session name has @ prefix
  const toSessionRef = (name: string): string => (name.startsWith('@') ? name : `@${name}`);

  // Separate queryable sessions from unavailable ones
  const queryableSessions: SessionData[] = [];
  const skippedSessions: SessionGrepSkipped[] = [];

  for (const session of allSessionEntries) {
    if (isSessionQueryable(session)) {
      queryableSessions.push(session);
    } else {
      const status = getBridgeStatus(session);
      skippedSessions.push({
        name: toSessionRef(session.name),
        status,
      });
    }
  }

  // Query all queryable sessions in parallel
  const settled = await Promise.allSettled(
    queryableSessions.map(async (session): Promise<SessionGrepResult> => {
      const sessionName = toSessionRef(session.name);
      const result = await withSessionClient(sessionName, async (client) => {
        return searchClient(client, pattern, matcher, options, sessionName);
      });
      return {
        name: sessionName,
        ...result,
      };
    })
  );

  // Separate successes and failures
  const results: SessionGrepResult[] = [];
  const resultsWithMatches: SessionGrepResult[] = [];
  const errors: SessionGrepError[] = [];

  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === 'fulfilled') {
      results.push(outcome.value);
      if (countMatches(outcome.value) > 0) {
        resultsWithMatches.push(outcome.value);
      }
    } else {
      const reason: unknown = outcome.reason;
      errors.push({
        name: toSessionRef(queryableSessions[i]!.name),
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }

  const totalMatches = sumMatchesByType(results);
  const totalMatchCount = results.reduce((sum, r) => sum + countMatches(r), 0);

  // Apply max-results limit across all sessions (only affects sessions with matches)
  let displayResultsWithMatches = resultsWithMatches;
  let totalTruncated = 0;
  if (options.maxResults != null) {
    let remaining = options.maxResults;
    displayResultsWithMatches = [];
    for (const r of resultsWithMatches) {
      if (remaining <= 0) {
        totalTruncated += countMatches(r);
        continue;
      }
      const { result: truncR, truncated } = truncateResult(r, remaining);
      remaining -= countMatches(truncR);
      totalTruncated += truncated;
      displayResultsWithMatches.push({ ...r, ...truncR });
    }
  }

  if (options.outputMode === 'json') {
    // Build unified sessions array: live results (all, even zero matches), errors, and skipped
    const truncatedResultsByName = new Map(displayResultsWithMatches.map((r) => [r.name, r]));
    const sessionEntries = [
      ...results.map((r) => {
        if (options.maxResults == null) {
          // No truncation — use original result
          return {
            name: r.name,
            status: 'live' as const,
            instructions: r.instructions,
            tools: r.tools,
            resources: r.resources,
            prompts: r.prompts,
          };
        }
        // With truncation: use truncated version if available, otherwise show empty
        const display = truncatedResultsByName.get(r.name);
        return {
          name: r.name,
          status: 'live' as const,
          instructions: display?.instructions ?? false,
          tools: display?.tools ?? [],
          resources: display?.resources ?? [],
          prompts: display?.prompts ?? [],
        };
      }),
      ...errors.map((e) => ({
        name: e.name,
        status: 'error' as const,
        error: e.error,
      })),
      ...skippedSessions.map((s) => ({
        name: s.name,
        status: s.status,
      })),
    ];

    const jsonOutput: Record<string, unknown> = {
      sessions: sessionEntries,
      totalMatches: {
        ...totalMatches,
        ...(totalTruncated > 0 ? { truncated: totalTruncated } : {}),
      },
    };
    console.log(formatJson(jsonOutput));
  } else {
    const lines: string[] = [];

    // Show unavailable sessions first
    for (const skipped of skippedSessions) {
      lines.push(formatSkippedSession(skipped));
    }

    for (const r of displayResultsWithMatches) {
      lines.push(theme.cyan(r.name));
      lines.push(...formatGrepResultHuman(r, '  ', pattern, options));
      lines.push('');
    }

    // Show warnings for failed sessions
    for (const err of errors) {
      lines.push(theme.yellow(`Warning: ${err.name} \u2014 ${err.error}`));
    }

    if (totalMatchCount === 0 && skippedSessions.length === 0) {
      console.log('No matches found.');
    } else {
      if (totalMatchCount > 0) {
        const sessionCount = resultsWithMatches.length;
        const showing = totalMatchCount - totalTruncated;
        const suffix = totalTruncated > 0 ? ` (showing ${showing})` : '';
        lines.push(
          chalk.dim(
            `${totalMatchCount} ${totalMatchCount === 1 ? 'match' : 'matches'} across ${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'}${suffix}.`
          )
        );
      } else if (lines.length > 0) {
        lines.push('');
        lines.push('No matches found.');
      }
      console.log(lines.join('\n'));
    }
  }

  return totalMatchCount > 0 ? 0 : 1;
}
