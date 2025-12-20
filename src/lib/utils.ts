/**
 * Utility functions for mcpc
 * Provides path handling, validation, and common helpers
 */

import { homedir } from 'os';
import { join, resolve, isAbsolute } from 'path';
import { mkdir, access, constants, stat } from 'fs/promises';

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
 */
export function getMcpcHome(): string {
  // TODO: Add support for the env var MCPC_HOME_DIR
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
 * Get the logs directory path (~/.mcpc/logs/)
 */
export function getLogsDir(): string {
  return join(getMcpcHome(), 'logs');
}

/**
 * Get the history file path (~/.mcpc/history)
 */
export function getHistoryFilePath(): string {
  return join(getMcpcHome(), 'history');
}

/**
 * Get the auth profiles file path (~/.mcpc/auth-profiles.json)
 */
export function getAuthProfilesFilePath(): string {
  return join(getMcpcHome(), 'auth-profiles.json');
}

/**
 * Ensure a directory exists, creating it if necessary
 */
export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true });
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
export async function exists(filepath: string): Promise<boolean> {
  try {
    await access(filepath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a path is a file
 */
export async function isFile(filepath: string): Promise<boolean> {
  try {
    const stats = await stat(filepath);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Check if a path is a directory
 */
export async function isDirectory(filepath: string): Promise<boolean> {
  try {
    const stats = await stat(filepath);
    return stats.isDirectory();
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
 * Normalize an MCP server URL by adding https:// if no scheme is present
 * Also converts hostname to lowercase and removes username, password, and hash
 * Returns the normalized URL or throws an error if invalid
 */
export function normalizeServerUrl(str: string): string {
  let urlString = str;

  // Add https:// if no scheme is present
  if (!str.includes('://')) {
    urlString = `https://${str}`;
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
 * Extract hostname from a URL for authentication key
 * Returns only the hostname in lowercase (port is not relevant for auth)
 */
export function getAuthServerKey(urlString: string): string {
  const url = new URL(normalizeServerUrl(urlString));
  return url.hostname.toLowerCase();
}

/**
 * Validate if a string is a valid session name
 * Session names must start with @ followed be alphanumeric string with hyphens/underscores, 1-64 chars
 */
export function isValidSessionName(name: string): boolean {
  return /^@[a-zA-Z0-9_-]{1,64}$/.test(name);
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
 * Wait for a file to exist with optional timeout
 */
export async function waitForFile(
  filepath: string,
  options: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const { timeout = 10000, interval = 100 } = options;
  const startTime = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await exists(filepath)) {
      return;
    }

    if (Date.now() - startTime >= timeout) {
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
 * Check if a process with the given PID is running
 */
export function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch {
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
