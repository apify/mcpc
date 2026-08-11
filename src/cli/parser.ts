/**
 * Command-line argument parsing utilities
 * Pure functions with no external dependencies for easy testing
 */
import { ClientError } from '../lib/index.js';
import { X402_SCHEME_PREFERENCES } from '../lib/types.js';

/**
 * Check if an environment variable is set to a truthy value
 * Truthy values: '1', 'true', 'yes' (case-insensitive)
 */
function isEnvTrue(envVar: string | undefined): boolean {
  if (!envVar) return false;
  const normalized = envVar.toLowerCase().trim();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/**
 * Get verbose flag from environment variable
 */
export function getVerboseFromEnv(): boolean {
  return isEnvTrue(process.env.MCPC_VERBOSE);
}

/**
 * Get JSON mode flag from environment variable
 */
export function getJsonFromEnv(): boolean {
  return isEnvTrue(process.env.MCPC_JSON);
}

/**
 * Disambiguate `--x402 <next>` when `<next>` is not a valid scheme.
 *
 * Commander's `[optional]` arg parser greedily consumes the next token as the
 * option value, so `mcpc connect --x402 mcp.apify.com @s` would parse the URL
 * as the scheme. Rewriting such cases to `--x402=auto` leaves `<next>` as a
 * positional. Tokens following `--x402` that match a real scheme are passed
 * through unchanged.
 */
export function preProcessX402Argv(argv: string[]): string[] {
  const schemes = X402_SCHEME_PREFERENCES as readonly string[];
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg !== '--x402') {
      out.push(arg);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && schemes.includes(next)) {
      out.push(arg, next);
      i++;
    } else {
      out.push('--x402=auto');
    }
  }
  return out;
}

/**
 * Rewrite a bare `mcpc --skill` into `mcpc help --skill`.
 *
 * `--skill` is an undocumented alias — agents reach for the flag form first, and
 * an unknown-option error there is a dead end. Only an invocation with no
 * positional token at all is rewritten, so `mcpc @s --skill`, `mcpc help --skill`
 * and friends keep their existing behaviour (including their errors). `--help`
 * also wins, so it keeps printing usage rather than the guide.
 */
export function preProcessSkillArgv(argv: string[]): string[] {
  const args = argv.slice(2);
  if (!args.includes('--skill') || hasPositionalArg(args)) return argv;
  if (args.includes('--help') || args.includes('-h')) return argv;
  return [...argv.slice(0, 2), 'help', ...args];
}

/** Whether `args` contains a non-option token (a command, session, or value). */
function hasPositionalArg(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith('-')) return true;
    if (optionTakesValue(arg) && !arg.includes('=')) i++; // skip option value
  }
  return false;
}

// Global options that take a value (not boolean flags)
const GLOBAL_OPTIONS_WITH_VALUES = ['--timeout', '--profile', '--max-chars'];

// All options that take a value — used by optionTakesValue() to correctly skip
// the next arg when scanning for command tokens. Includes subcommand-specific
// options so misplaced flags still get their values skipped during scanning.
const OPTIONS_WITH_VALUES = [
  ...GLOBAL_OPTIONS_WITH_VALUES,
  '--schema',
  '--schema-mode',
  '-H',
  '--header',
  '--proxy',
  '--proxy-bearer-token',
  '--scope',
  '--grant',
  '-m',
  '--max-results',
  '--client-id',
  '--client-secret',
  '--client-key',
  '--client-key-alg',
  '--token-endpoint',
  '--client-metadata-url',
  '--no-client-metadata-url',
  '--callback-port',
  '-o',
  '--output',
  '--amount',
  '--expiry',
];

// Global options recognized before the first command token.
// validateOptions() stops at the first non-option token, so subcommand-specific
// options (--scope, --proxy, --full, --x402, etc.) are handled by Commander.
const KNOWN_OPTIONS = [
  ...GLOBAL_OPTIONS_WITH_VALUES,
  '-j',
  '--json',
  '-v',
  '--version',
  '-h',
  '--help',
  '--verbose',
  '--insecure',
];

/**
 * All known top-level commands
 */
export const KNOWN_COMMANDS = [
  'help',
  'login',
  'logout',
  'connect',
  'close',
  'restart',
  'clean',
  'grep',
  'x402',
];

/**
 * All known session subcommands (used in help and error messages)
 */
export const KNOWN_SESSION_COMMANDS = [
  'help',
  'close',
  'restart',
  'tools-list',
  'tools-get',
  'tools-call',
  'resources-list',
  'resources-read',
  'resources-subscribe',
  'resources-unsubscribe',
  'resources-templates-list',
  'skills-list',
  'skills-get',
  'prompts-list',
  'prompts-get',
  'logging-set-level',
  'ping',
  'server-discover',
  'logs',
  'tasks-list',
  'tasks-get',
  'tasks-result',
  'tasks-cancel',
  'grep',
];

/**
 * Compute Levenshtein distance between two strings.
 * Uses two flat Int32Arrays (always initialized to 0) to avoid undefined-index issues.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = new Int32Array(n + 1);
  let curr = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = (prev[j] as number) + 1;
      const ins = (curr[j - 1] as number) + 1;
      const sub = (prev[j - 1] as number) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] as number;
}

/**
 * Suggest the closest matching command for a given unknown input.
 * Returns the closest match if within a reasonable edit distance, or undefined.
 *
 * Also detects reversed hyphenated commands (e.g., "list-tools" → "tools-list")
 * which is the most common mistake pattern.
 */
export function suggestCommand(
  input: string,
  commands: string[],
  maxDistance = 3
): string | undefined {
  const normalized = input.toLowerCase();

  // Check for reversed hyphenated command (e.g., "list-tools" → "tools-list")
  if (normalized.includes('-')) {
    const parts = normalized.split('-');
    const reversed = parts.reverse().join('-');
    const reversedMatch = commands.find((cmd) => cmd.toLowerCase() === reversed);
    if (reversedMatch) return reversedMatch;
  }

  // Check for bare prefix (e.g., "tools" → "tools-list", "resources" → "resources-list")
  const prefixSuggestions: Record<string, string> = {
    tools: 'tools-list',
    resources: 'resources-list',
    prompts: 'prompts-list',
    skills: 'skills-list',
  };
  const prefixSuggestion = prefixSuggestions[normalized];
  if (prefixSuggestion && commands.includes(prefixSuggestion)) {
    return prefixSuggestion;
  }

  // Fall back to Levenshtein distance
  let best: string | undefined;
  let bestDist = Infinity;
  for (const cmd of commands) {
    const dist = levenshtein(normalized, cmd.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = cmd;
    }
  }
  return bestDist <= maxDistance ? best : undefined;
}

/**
 * Normalize an MCP JSON-RPC-style method name (e.g. "tools/list",
 * "logging/setLevel", "resources/templates/list") into mcpc's hyphenated
 * command form ("tools-list", "logging-set-level", "resources-templates-list").
 * Returns the input unchanged if it contains no '/'.
 *
 * Undocumented convenience: accepted silently as an alias wherever a command
 * name is expected, for users who reach for the raw protocol method name out
 * of habit. Never advertised in --help or "Did you mean?" suggestions.
 */
export function normalizeSlashCommand(token: string): string {
  if (!token.includes('/')) return token;
  return token
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/\//g, '-');
}

/**
 * Rewrite the first positional command token in `args` if it's a slash-style
 * MCP method name (see normalizeSlashCommand) that maps to a known hyphenated
 * command. Only the command-name slot is touched — later positional args
 * (tool names, resource URIs, etc.) are left untouched even if they contain '/'.
 *
 * @param startIndex where to start scanning for the first positional token
 *   (2 when `args` mirrors process.argv with its [node, script] prefix, 0 when
 *   `args` is already a bare argument list).
 */
export function normalizeSlashCommandArgs(
  args: string[],
  knownCommands: string[],
  startIndex: number
): string[] {
  for (let i = startIndex; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith('-')) {
      if (optionTakesValue(arg) && !arg.includes('=')) i++; // skip option value
      continue;
    }
    if (arg.includes('/')) {
      const normalized = normalizeSlashCommand(arg);
      if (knownCommands.includes(normalized)) {
        const result = [...args];
        result[i] = normalized;
        return result;
      }
    }
    return args;
  }
  return args;
}

/**
 * Check if an option always takes a value
 */
export function optionTakesValue(arg: string): boolean {
  const optionName = arg.includes('=') ? arg.substring(0, arg.indexOf('=')) : arg;
  return OPTIONS_WITH_VALUES.includes(optionName);
}

/**
 * Check if there is a non-option argument in args starting from index 2
 * (index 0 = node, index 1 = script path — mirrors process.argv format)
 */
export function hasSubcommand(args: string[]): boolean {
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith('-')) {
      if (optionTakesValue(arg) && !arg.includes('=')) {
        i++; // skip value
      }
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Check if an option is known
 */
function isKnownOption(arg: string): boolean {
  // Extract option name (before = if present)
  const optionName = arg.includes('=') ? arg.substring(0, arg.indexOf('=')) : arg;
  return KNOWN_OPTIONS.includes(optionName);
}

/**
 * Validate that all global options (before the first command token) are known.
 * Stops at the first non-option argument so subcommand-specific options
 * (e.g. --scope, --payment-required, -o/--output) are never checked here.
 * @throws ClientError if unknown option is found
 */
export function validateOptions(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg.startsWith('-')) {
      if (!isKnownOption(arg)) {
        throw new ClientError(`Unknown option: ${arg}`);
      }
      // Skip the value for options that take values
      if (optionTakesValue(arg) && !arg.includes('=') && i + 1 < args.length) {
        i++;
      }
    } else {
      // Stop at the first non-option argument (command token).
      // Options after this point are subcommand-specific and are handled by Commander.
      break;
    }
  }
}

/**
 * Validate argument values (--schema-mode, --timeout, etc.) for global options only.
 * Stops at the first non-option argument so subcommand-specific options are ignored.
 * @throws ClientError if invalid value is found
 */
export function validateArgValues(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];
    if (!arg) continue;

    if (!arg.startsWith('-')) {
      // Stop at the first non-option argument (command token)
      break;
    }

    // Validate --timeout is a number
    if (arg === '--timeout' && nextArg) {
      const timeoutSecs = parseInt(nextArg, 10);
      if (isNaN(timeoutSecs) || timeoutSecs <= 0) {
        throw new ClientError(
          `Invalid --timeout value: "${nextArg}". Must be a positive number (seconds).`
        );
      }
    }

    // Validate --proxy format (but don't parse yet, just check basic format)
    if (arg === '--proxy' && nextArg) {
      // Basic validation - just check it's not empty
      // Full parsing with better error messages is done in parseProxyArg
      if (!nextArg.trim()) {
        throw new ClientError('--proxy requires a value in format [HOST:]PORT');
      }
    }
  }
}

/**
 * Extract option values from args
 * Environment variables MCPC_VERBOSE and MCPC_JSON are used as defaults
 */
export function extractOptions(args: string[]): {
  timeoutSecs?: number;
  profile?: string;
  insecure?: boolean;
  verbose: boolean;
  json: boolean;
} {
  const options = {
    verbose: args.includes('--verbose') || getVerboseFromEnv(),
    json: args.includes('--json') || args.includes('-j') || getJsonFromEnv(),
  };

  // Extract --timeout (value is in seconds)
  const timeoutIndex = args.findIndex((arg) => arg === '--timeout');
  const timeoutValue =
    timeoutIndex >= 0 && timeoutIndex + 1 < args.length ? args[timeoutIndex + 1] : undefined;
  const timeoutSecs = timeoutValue ? parseInt(timeoutValue, 10) : undefined;

  // Extract --profile
  const profileIndex = args.findIndex((arg) => arg === '--profile');
  const profile =
    profileIndex >= 0 && profileIndex + 1 < args.length ? args[profileIndex + 1] : undefined;

  // Extract --insecure (boolean flag)
  const insecure = args.includes('--insecure') || undefined;

  return {
    ...options,
    ...(timeoutSecs !== undefined && { timeoutSecs }),
    ...(profile && { profile }),
    ...(insecure && { insecure }),
  };
}

/**
 * Returns true if str is a valid URL with a non-empty host
 */
function isValidUrlWithHost(str: string): boolean {
  try {
    return new URL(str).host.length > 0;
  } catch {
    return false;
  }
}

/**
 * Returns true if s looks like a filesystem path rather than a hostname.
 * Used to decide whether the left side of a colon is a file path or a host.
 */
function looksLikeFilePath(s: string): boolean {
  // Unix absolute or home-relative paths
  if (s.startsWith('/') || s.startsWith('~')) return true;
  // Explicit relative paths
  if (s.startsWith('./') || s.startsWith('../')) return true;
  // Windows absolute paths: C:\ or C:/
  if (/^[A-Za-z]:[/\\]/.test(s)) return true;
  // Contains a directory separator (e.g. subdir/file.json)
  if (s.includes('/') || s.includes('\\')) return true;
  // Known config file extensions without any path prefix
  if (/\.(json|yaml|yml)$/i.test(s)) return true;
  return false;
}

/**
 * Parse a server argument into a URL or config file entry.
 *
 * 1. URL: arg (as-is, or prefixed with https:// or http://) is a valid URL with a non-empty host.
 *    Args that start with a path character (/, ~, .) skip the prefix check to avoid false positives
 *    (e.g. https://~/ or https:///// parse with unusual hosts but are clearly file paths).
 * 2. If arg contains "://" but failed URL validation above → null (invalid full-URL syntax).
 * 3. Config entry: colon present, entry non-empty, AND left side looks like a file path.
 *    Windows drive-letter paths (C:\...) use lastIndexOf(':') so the drive colon is skipped.
 * 4. Otherwise: returns null (caller should report an error)
 */
export function parseServerArg(
  arg: string
):
  | { type: 'url'; url: string }
  | { type: 'config'; file: string; entry: string }
  | { type: 'config-file'; file: string }
  | null {
  // Step 1a: try arg as-is (covers full URLs like https://... or ftp://...)
  if (isValidUrlWithHost(arg)) {
    return { type: 'url', url: arg };
  }

  // Step 1b: if arg contains "://" it's clearly intended as a full URL — don't fall through to
  // the config-entry heuristic (e.g. "https://host:badport" should not become file="https").
  if (arg.includes('://')) {
    return null;
  }

  // Step 2: try adding https:// prefix for bare hostnames and host:port combos.
  // Skip if arg starts with a path character — those are file paths, not hostnames.
  // Skip if arg ends with a config file extension (e.g., config.json) — clearly a file, not a hostname.
  // Skip if arg ends with ':' — dangling colon is not a valid hostname.
  // Skip if arg matches the config-entry pattern (e.g. `relative/path.json:entry`) — the
  // `https://` prefix would otherwise parse it as a URL with host=first-segment and mask the
  // file:entry intent.
  const isWindowsDrive = /^[A-Za-z]:[/\\]/.test(arg);
  const startsWithPathChar =
    arg.startsWith('/') || arg.startsWith('~') || arg.startsWith('.') || isWindowsDrive;
  const hasConfigExtension = /\.(json|yaml|yml)$/i.test(arg);

  // Step 3: config file entry — colon separates file path from entry name.
  // The left side must look like a file path (not a bare hostname).
  // Special case: Windows drive-letter paths (C:\...) have a colon at position 1;
  // use lastIndexOf(':') so we skip that drive colon and find the entry separator.
  const colonIndex = isWindowsDrive ? arg.lastIndexOf(':') : arg.indexOf(':');
  const hasConfigEntryShape =
    colonIndex > 0 &&
    colonIndex < arg.length - 1 &&
    looksLikeFilePath(arg.substring(0, colonIndex));

  if (!startsWithPathChar && !hasConfigExtension && !hasConfigEntryShape && !arg.endsWith(':')) {
    if (isValidUrlWithHost('https://' + arg)) {
      return { type: 'url', url: arg };
    }
  }

  if (hasConfigEntryShape) {
    const file = arg.substring(0, colonIndex);
    const entry = arg.substring(colonIndex + 1);
    return { type: 'config', file, entry };
  }

  // Step 4: bare config file path (no :entry suffix) — connect all servers from the file.
  // Matches if the entire arg looks like a file path (e.g., ~/.vscode/mcp.json, ./config.json)
  if (looksLikeFilePath(arg)) {
    return { type: 'config-file', file: arg };
  }

  // Step 5: unrecognised
  return null;
}

/**
 * Auto-parse a value: try JSON.parse, if fails treat as string
 * This allows natural CLI usage like: count:=10, enabled:=true, name:=hello
 */
function autoParseValue(value: string): unknown {
  // Integers beyond Number.MAX_SAFE_INTEGER (e.g. snowflake IDs) would silently
  // lose precision as JS numbers — pass them through as strings instead.
  if (/^-?\d+$/.test(value)) {
    const abs = value.startsWith('-') ? value.slice(1) : value;
    if (abs.length >= 16 && !Number.isSafeInteger(Number(value))) {
      return value;
    }
  }

  // Try to parse as JSON (handles numbers, booleans, null, arrays, objects)
  try {
    return JSON.parse(value);
  } catch {
    // Not valid JSON, treat as string
    return value;
  }
}

/**
 * Parse command arguments (positional args after tool/prompt name)
 * Supports two formats:
 * 1. Inline JSON: '{"key":"value"}' or '[...]'
 * 2. Key:=value pairs: key:=value (auto-parsed as JSON or string)
 *
 * @param args - Array of positional argument strings
 * @returns Parsed arguments as key-value object
 * @throws ClientError if arguments are invalid
 */
export function parseCommandArgs(args: string[] | undefined): Record<string, unknown> {
  if (!args || args.length === 0) {
    return {};
  }

  // Check if first arg is inline JSON object/array
  const firstArg = args[0];
  if (firstArg && (firstArg.startsWith('{') || firstArg.startsWith('['))) {
    // Parse as inline JSON
    if (args.length > 1) {
      throw new ClientError('When using inline JSON, only one argument is allowed');
    }
    try {
      const parsedArgs: unknown = JSON.parse(firstArg);
      if (typeof parsedArgs !== 'object' || parsedArgs === null) {
        throw new ClientError('Inline JSON must be an object or array');
      }
      return parsedArgs as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ClientError) {
        throw error;
      }
      throw new ClientError(`Invalid JSON: ${(error as Error).message}`);
    }
  }

  // Parse key:=value pairs (only := syntax supported)
  const parsedArgs: Record<string, unknown> = {};
  for (const pair of args) {
    if (!pair.includes(':=')) {
      throw new ClientError(
        `Invalid argument format: "${pair}". Use key:=value pairs or inline JSON.\n` +
          `Examples: name:=hello count:=10 enabled:=true '{"key":"value"}'`
      );
    }

    // Split only at the first occurrence of :=
    const colonEqualIndex = pair.indexOf(':=');
    const key = pair.substring(0, colonEqualIndex);
    const rawValue = pair.substring(colonEqualIndex + 2);

    if (!key) {
      throw new ClientError(`Invalid argument: "${pair}" - missing key before :=`);
    }

    // Auto-parse: try JSON, fallback to string
    parsedArgs[key] = autoParseValue(rawValue);
  }

  return parsedArgs;
}

/**
 * Check if stdin has data available (non-TTY, piped input)
 */
export function hasStdinData(): boolean {
  return !process.stdin.isTTY;
}

/**
 * Read and parse JSON from stdin
 * Used when arguments are piped: echo '{"key":"value"}' | mcpc @server tools-call my-tool
 *
 * @returns Promise resolving to parsed arguments
 * @throws ClientError if stdin cannot be read or contains invalid JSON
 */
export async function readStdinArgs(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';

    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });

    process.stdin.on('end', () => {
      if (!data.trim()) {
        resolve({});
        return;
      }

      try {
        const parsed: unknown = JSON.parse(data);
        if (typeof parsed !== 'object' || parsed === null) {
          reject(new ClientError('Stdin must contain a JSON object'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch (error) {
        reject(new ClientError(`Invalid JSON from stdin: ${(error as Error).message}`));
      }
    });

    process.stdin.on('error', (error) => {
      reject(new ClientError(`Failed to read stdin: ${error.message}`));
    });

    // Start reading
    process.stdin.resume();
  });
}

/**
 * Parse --header CLI flags into a headers object
 * Format: "Key: Value" (colon-separated)
 */
export function parseHeaderFlags(headerFlags: string[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (headerFlags) {
    for (const header of headerFlags) {
      const colonIndex = header.indexOf(':');
      if (colonIndex < 1) {
        throw new ClientError(`Invalid header format: ${header}. Use "Key: Value"`);
      }
      const key = header.substring(0, colonIndex).trim();
      const value = header.substring(colonIndex + 1).trim();
      headers[key] = value;
    }
  }
  return headers;
}

/**
 * Parse --proxy argument in format [HOST:]PORT
 * Returns { host, port } with default host 127.0.0.1
 *
 * Examples:
 *   "8080" -> { host: "127.0.0.1", port: 8080 }
 *   "0.0.0.0:8080" -> { host: "0.0.0.0", port: 8080 }
 *   "localhost:3000" -> { host: "localhost", port: 3000 }
 */
export function parseProxyArg(value: string): { host: string; port: number } {
  const DEFAULT_HOST = '127.0.0.1';

  // Check if value contains a colon (host:port format)
  const lastColonIndex = value.lastIndexOf(':');

  if (lastColonIndex === -1) {
    // No colon - just port
    const port = parseInt(value, 10);
    if (isNaN(port) || port <= 0 || port > 65535) {
      throw new ClientError(
        `Invalid --proxy port: "${value}". Must be a number between 1 and 65535.`
      );
    }
    return { host: DEFAULT_HOST, port };
  }

  // Has colon - host:port format
  const host = value.substring(0, lastColonIndex);
  const portStr = value.substring(lastColonIndex + 1);
  const port = parseInt(portStr, 10);

  if (!host) {
    throw new ClientError(`Invalid --proxy format: "${value}". Host cannot be empty.`);
  }

  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new ClientError(
      `Invalid --proxy port: "${portStr}". Must be a number between 1 and 65535.`
    );
  }

  return { host, port };
}
