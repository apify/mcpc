/**
 * Utility functions for mcpc
 * Provides path handling, validation, and common helpers
 */

import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { join, resolve, isAbsolute } from 'path';
import { mkdir, access, constants, rename } from 'fs/promises';
import { ClientError } from './errors.js';

/**
 * Expand tilde (~) to home directory in paths
 */
export function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return join(homedir(), filepath.slice(1));
  }
  return filepath;
}

/**
 * Resolve a path, expanding home directory and making absolute
 */
export function resolvePath(filepath: string, basePath?: string): string {
  const expanded = expandHome(filepath);
  if (isAbsolute(expanded)) {
    return resolve(expanded);
  }
  return resolve(basePath || process.cwd(), expanded);
}

/**
 * Get the mcpc home directory (~/.mcpc)
 * Can be overridden with MCPC_HOME_DIR environment variable
 */
export function getMcpcHome(): string {
  const envHome = process.env.MCPC_HOME_DIR;
  if (envHome) {
    return resolvePath(envHome);
  }
  return expandHome('~/.mcpc');
}

/**
 * Get the sessions file path (~/.mcpc/sessions.json)
 */
export function getSessionsFilePath(): string {
  return join(getMcpcHome(), 'sessions.json');
}

/**
 * Get the bridges directory path (~/.mcpc/bridges/)
 */
export function getBridgesDir(): string {
  return join(getMcpcHome(), 'bridges');
}

/**
 * Get the socket/pipe path for a session's bridge process.
 *
 * On Unix/macOS: Returns a Unix domain socket path in the bridges directory.
 * On Windows: Returns a named pipe path with a hash of the home directory
 *             to avoid conflicts between different mcpc instances.
 *
 * @param sessionName - The session name (e.g., "@my-session")
 * @param pid - The bridge process PID (each bridge gets a unique socket path)
 * @returns The platform-appropriate socket/pipe path
 */
export function getSocketPath(sessionName: string, pid: number): string {
  const suffix = `.${pid}`;
  if (process.platform === 'win32') {
    // Windows named pipes are global, so include a hash of the home directory
    // to avoid conflicts between different mcpc instances
    const homeHash = createHash('sha256').update(getMcpcHome()).digest('hex').slice(0, 8);
    return `\\\\.\\pipe\\mcpc-${homeHash}-${sessionName}${suffix}`;
  }

  // Unix/macOS: use socket file in bridges directory (naturally isolated per home dir)
  return join(getBridgesDir(), `${sessionName}${suffix}.sock`);
}

/**
 * Get the logs directory path (~/.mcpc/logs/)
 */
export function getLogsDir(): string {
  return join(getMcpcHome(), 'logs');
}

/**
 * Get the auth profiles file path (~/.mcpc/profiles.json)
 */
export function getAuthProfilesFilePath(): string {
  return join(getMcpcHome(), 'profiles.json');
}

/**
 * Get the wallets file path (~/.mcpc/wallets.json)
 */
export function getWalletsFilePath(): string {
  return join(getMcpcHome(), 'wallets.json');
}

/**
 * Ensure a directory exists, creating it if necessary.
 * Uses mode 0o700 (owner-only) by default to protect sensitive data
 * like session files, credentials, and Unix sockets.
 */
export async function ensureDir(dirPath: string, mode: number = 0o700): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true, mode });
  } catch (error) {
    // Ignore error if directory already exists
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Check if a file or directory exists
 */
export async function fileExists(filepath: string): Promise<boolean> {
  try {
    await access(filepath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate if a string is a valid URL with http:// or https:// scheme
 */
export function isValidHttpUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Normalize an MCP server URL by adding a scheme if not present
 * - localhost/127.0.0.1 addresses default to http:// (common for local dev/proxy)
 * - All other addresses default to https://
 * Also converts hostname to lowercase and removes username, password, and hash
 * Returns the normalized URL or throws an error if invalid
 */
export function normalizeServerUrl(str: string): string {
  let urlString = str;

  // Add scheme if not present
  if (!str.includes('://')) {
    // Extract hostname (before any port or path)
    const hostPart = (str.split(/[:/]/)[0] || '').toLowerCase();
    const isLocalhost = hostPart === 'localhost' || hostPart === '127.0.0.1';
    // Default to http:// for localhost, https:// for everything else
    urlString = isLocalhost ? `http://${str}` : `https://${str}`;
  }

  // Validate URL
  if (!isValidHttpUrl(urlString)) {
    throw new Error(`Invalid MCP server URL: ${str}`);
  }

  const url = new URL(urlString);

  // Normalize URL components
  url.hostname = url.hostname.toLowerCase();
  url.username = '';
  url.password = '';
  url.hash = '';

  let result = url.toString();

  // Remove trailing slash if no path (only scheme://host or scheme://host:port)
  if (url.pathname === '/' && !url.search) {
    result = result.slice(0, -1);
  }

  return result;
}

/**
 * Extract a canonical server host identifier from a URL
 * Used for auth profile storage keys and display
 *
 * Returns:
 * - `hostname` for standard ports (443 for https, 80 for http)
 * - `hostname:port` for non-standard ports
 *
 * Examples:
 * - `https://mcp.apify.com` → `mcp.apify.com`
 * - `https://mcp.apify.com/path` → `mcp.apify.com`
 * - `https://example.com:8443` → `example.com:8443`
 * - `http://localhost:3000` → `localhost:3000`
 */
export function getServerHost(urlString: string): string {
  const url = new URL(normalizeServerUrl(urlString));
  const hostname = url.hostname.toLowerCase();
  const port = url.port;

  // Include port only if non-standard
  // Standard ports: 443 for https, 80 for http
  if (port && port !== '443' && port !== '80') {
    return `${hostname}:${port}`;
  }
  return hostname;
}

/**
 * Validate if a string is a valid session name.
 * Session names must start with @ followed by alphanumeric string with hyphens/underscores, 1-64 chars
 */
export function isValidSessionName(name: string): boolean {
  return /^@[a-zA-Z0-9_-]{1,64}$/.test(name);
}

/** Common hostname prefixes to strip when generating session names */
const COMMON_HOST_PREFIXES = ['mcp.', 'api.', 'www.'];

/**
 * Sanitize a string into a valid session name part (without @ prefix).
 * Replaces invalid characters with hyphens, collapses consecutive hyphens,
 * and trims leading/trailing hyphens. Truncates to 64 characters.
 */
function sanitizeSessionName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-') // replace invalid chars with hyphens
    .replace(/-{2,}/g, '-') // collapse consecutive hyphens
    .replace(/^-+|-+$/g, '') // trim leading/trailing hyphens
    .slice(0, 64);
}

/**
 * Generate a session name from a parsed server argument.
 *
 * For URL targets: extracts the "brand" part of the hostname.
 *   - Strips common prefixes (mcp., api., www.)
 *   - Takes the first remaining label (before the first dot)
 *   - Appends non-standard port as -<port>
 *   Examples: mcp.apify.com → apify, mcp.example.co.uk → example, localhost:3000 → localhost-3000
 *
 * For config entries: uses the entry name directly (sanitized).
 *   Example: ~/.vscode/mcp.json:filesystem → filesystem
 *
 * @returns Session name with @ prefix (e.g., @apify)
 */
export function generateSessionName(
  parsed: { type: 'url'; url: string } | { type: 'config'; file: string; entry: string }
): string {
  if (parsed.type === 'config') {
    const name = sanitizeSessionName(parsed.entry);
    return `@${name || 'session'}`;
  }

  // URL case: parse and extract hostname
  const url = new URL(normalizeServerUrl(parsed.url));
  let hostname = url.hostname.toLowerCase();

  // For IP addresses, use the full address (dots will be sanitized to hyphens)
  const isIpAddress = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
  let name: string;

  if (isIpAddress) {
    name = hostname;
  } else {
    // Strip common prefixes
    for (const prefix of COMMON_HOST_PREFIXES) {
      if (hostname.startsWith(prefix) && hostname.length > prefix.length) {
        hostname = hostname.slice(prefix.length);
        break; // only strip one prefix
      }
    }

    // Take the first label (before the first dot)
    const labels = hostname.split('.');
    name = labels.length >= 2 ? (labels[0] ?? hostname) : hostname;
  }

  // Append non-standard port
  const port = url.port;
  if (port) {
    name += `-${port}`;
  }

  const sanitized = sanitizeSessionName(name);
  return `@${sanitized || 'session'}`;
}

/**
 * Validate if a string is a valid profile name.
 * Profile names must be alphanumeric with hyphens/underscores, 1-64 chars (no @ prefix)
 */
export function isValidProfileName(name: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(name);
}

/**
 * Validates the given profile name to ensure it adheres to the specified format.
 * Profile names must be alphanumeric with hyphens/underscores, 1-64 chars (no @ prefix)
 */
export function validateProfileName(profileName: string): void {
  if (!isValidProfileName(profileName)) {
    throw new ClientError(
      `Invalid profile name: ${profileName}\n` +
        `Profile names must be 1-64 alphanumeric characters with hyphens or underscores only (e.g., personal, work-account).`
    );
  }
}

/**
 * Validate if a string is a valid MCP resource URI
 */
export function isValidResourceUri(uri: string): boolean {
  try {
    new URL(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rename a file atomically with retry on transient Windows errors.
 *
 * On Windows, `rename()` can fail with EPERM/EBUSY/EACCES when the destination
 * file is briefly held open by another process (antivirus scanner, a sibling
 * mcpc bridge re-reading sessions.json, etc.). The failure window is short, so
 * a few quick retries with a small backoff are enough to recover.
 */
export async function atomicRename(src: string, dest: string): Promise<void> {
  const transientCodes = new Set(['EPERM', 'EBUSY', 'EACCES']);
  const maxAttempts = process.platform === 'win32' ? 10 : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await rename(src, dest);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !transientCodes.has(code) || attempt === maxAttempts) {
        throw error;
      }
      await sleep(20 * attempt);
    }
  }

  throw lastError;
}

/**
 * Wait for a file to exist with optional timeout
 */
export async function waitForFile(
  filepath: string,
  options: { timeoutMs?: number; interval?: number } = {}
): Promise<void> {
  const { timeoutMs = 10000, interval = 100 } = options;
  const startTime = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await fileExists(filepath)) {
      return;
    }

    if (Date.now() - startTime >= timeoutMs) {
      throw new Error(`Timeout waiting for file: ${filepath}`);
    }

    await sleep(interval);
  }
}

/**
 * Safely parse JSON with error handling
 */
export function parseJson<T = unknown>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    throw new Error(`Invalid JSON: ${(error as Error).message}`);
  }
}

/**
 * Stringify JSON with pretty printing
 */
export function stringifyJson(obj: unknown, pretty = false): string {
  return JSON.stringify(obj, null, pretty ? 2 : 0);
}

/**
 * Truncate a string to a maximum length
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Check if a process with the given PID is running.
 *
 * On Unix, `process.kill(pid, 0)` reliably checks process existence.
 * On Windows, `process.kill(pid, 0)` can return false positives because
 * the underlying `OpenProcess()` succeeds for zombie processes whose
 * handles haven't been fully released. We use `tasklist` instead, with
 * a short-lived cache so one call covers all PID checks within 2 seconds.
 */
export function isProcessAlive(pid: number): boolean {
  if (process.platform === 'win32') {
    return isProcessAliveTasklist(pid);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows process alive check using cached tasklist output.
 *
 * A single `tasklist` call fetches all PIDs and caches them for 2 seconds.
 * Subsequent checks within the TTL window are instant Set lookups.
 * This reduces hundreds of 1-2s process spawns to a handful.
 */
let _tasklistCache: Set<number> | null = null;
let _tasklistCacheTime = 0;
const TASKLIST_CACHE_TTL = 2000; // 2 seconds

/**
 * Invalidate the Windows tasklist cache used by isProcessAlive().
 * Call this after spawning a new child process so subsequent
 * isProcessAlive() checks pick up the new PID instead of returning
 * a stale false-negative from the pre-spawn snapshot.
 */
export function invalidateProcessAliveCache(): void {
  _tasklistCache = null;
  _tasklistCacheTime = 0;
}

function isProcessAliveTasklist(pid: number): boolean {
  const now = Date.now();
  if (_tasklistCache && now - _tasklistCacheTime < TASKLIST_CACHE_TTL) {
    return _tasklistCache.has(pid);
  }
  try {
    // Fetch ALL PIDs in one call (CSV format for reliable parsing)
    const output = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    _tasklistCache = new Set<number>();
    for (const line of output.split('\n')) {
      // CSV format: "Image Name","PID","Session Name","Session#","Mem Usage"
      const match = /"(\d+)"/.exec(line);
      if (match) _tasklistCache.add(Number(match[1]));
    }
    _tasklistCacheTime = now;
    return _tasklistCache.has(pid);
  } catch {
    _tasklistCache = null;
    return false;
  }
}

/**
 * Generate a unique request ID
 */
let requestIdCounter = 0;
export function generateRequestId(): string {
  return `req_${Date.now()}_${++requestIdCounter}`;
}

/**
 * Sentinel value used to replace sensitive header values when storing in sessions.json
 */
export const REDACTED_HEADER_VALUE = '<redacted>';

/**
 * Redact header values for secure storage
 * Replaces all header values with "<redacted>" sentinel
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  if (Object.keys(headers).length === 0) return headers;
  const redacted: Record<string, string> = {};
  for (const key of Object.keys(headers)) {
    redacted[key] = REDACTED_HEADER_VALUE;
  }
  return redacted;
}

/**
 * Check if an error message indicates MCP session expiration.
 * Used to detect when a server has invalidated a session so it can be marked as expired.
 *
 * @param errorMessage - The error message to check
 * @param options.hadActiveSession - When true, bare HTTP 404 errors are treated as session
 *   expiration (the server likely rejected a stale MCP-Session-Id). When false, 404 is only
 *   matched if the message explicitly mentions "session" — a bare 404 during initial connect
 *   likely means the URL is wrong, not that a session expired.
 */
export function isSessionExpiredError(
  errorMessage: string,
  options?: { hadActiveSession?: boolean }
): boolean {
  const msg = errorMessage.toLowerCase();

  // Explicit session-related messages — always indicate expiration
  if (
    msg.includes('session expired') ||
    /session(\s+id)?\s+\S+\s+not\s+found/.test(msg) ||
    msg.includes('session not found') ||
    msg.includes('invalid session') ||
    msg.includes('session is no longer valid')
  ) {
    return true;
  }

  // HTTP 404: only treat as session expiration when we had an active session ID.
  // A bare 404 during initial connect typically means the URL is wrong.
  // NOTE: exclude "tool not found" messages which are normal MCP errors.
  if (msg.includes('404') && !msg.includes('tool')) {
    // If the 404 message explicitly mentions "session", always match
    if (msg.includes('session')) {
      return true;
    }
    // Otherwise only match if we had an active MCP session (server rejected our session ID)
    return options?.hadActiveSession === true;
  }

  return false;
}

/**
 * Check if an error message indicates an HTTP redirect (3xx).
 * Redirects from an MCP endpoint suggest the URL is wrong (not an MCP server).
 */
export function isHttpRedirectError(errorMessage: string): boolean {
  const msg = errorMessage.toLowerCase();
  return (
    msg.includes('redirect') ||
    /30[1-8]/.test(msg) ||
    msg.includes('moved permanently') ||
    msg.includes('moved temporarily')
  );
}

/**
 * Enrich a raw error message with actionable context based on the error pattern.
 * Maps common HTTP/network errors to user-friendly messages with suggestions.
 */
export function enrichErrorMessage(errorMessage: string, serverUrl?: string): string {
  const msg = errorMessage.toLowerCase();
  const urlHint = serverUrl ? ` at ${serverUrl}` : '';

  // Connection refused
  if (msg.includes('econnrefused') || msg.includes('connection refused')) {
    return `Cannot reach server${urlHint}. Is the server running?\n  Original error: ${errorMessage}`;
  }

  // DNS resolution failure
  if (msg.includes('enotfound') || msg.includes('getaddrinfo')) {
    return `Cannot resolve hostname${urlHint}. Check the server URL.\n  Original error: ${errorMessage}`;
  }

  // HTTP 404 (not session-related)
  if (msg.includes('404')) {
    return `Server returned 404 Not Found${urlHint}. Check the endpoint URL.\n  Original error: ${errorMessage}`;
  }

  // HTTP redirects
  if (isHttpRedirectError(errorMessage)) {
    return `Server returned a redirect${urlHint}. This doesn't look like an MCP endpoint.\n  Original error: ${errorMessage}`;
  }

  // Timeout
  if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('timed out')) {
    return `Connection timed out${urlHint}. The server may be slow or unreachable.\n  Original error: ${errorMessage}`;
  }

  // TLS/SSL errors
  if (
    msg.includes('ssl') ||
    msg.includes('tls') ||
    msg.includes('certificate') ||
    msg.includes('cert')
  ) {
    return `TLS/SSL error${urlHint}. Check the server's certificate.\n  Original error: ${errorMessage}`;
  }

  // No enrichment possible
  return errorMessage;
}
