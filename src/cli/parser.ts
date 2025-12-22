/**
 * Command-line argument parsing utilities
 * Pure functions with no external dependencies for easy testing
 */
import { readFileSync } from 'fs';
import { ClientError, resolvePath } from '../lib/index.js';

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

// Options that take a value (not boolean flags)
const OPTIONS_WITH_VALUES = [
  '-c',
  '--config',
  '-H',
  '--header',
  '--timeout',
  '--profile',
  '--protocol-version',
  '--schema',
  '--schema-mode',
];

/**
 * Check if an option takes a value
 */
export function optionTakesValue(arg: string): boolean {
  const optionName = arg.includes('=') ? arg.substring(0, arg.indexOf('=')) : arg;
  return OPTIONS_WITH_VALUES.includes(optionName);
}

/**
 * Find the first non-option argument (the target)
 * Returns { target, targetIndex } or undefined if no target found
 */
export function findTarget(args: string[]): { target: string; targetIndex: number } | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    // Skip options and their values
    if (arg.startsWith('-')) {
      // If option takes a value and value is not inline (no =), skip next arg
      if (optionTakesValue(arg) && !arg.includes('=') && i + 1 < args.length) {
        i++; // Skip the value
      }
      continue;
    }

    // Found first non-option argument
    return { target: arg, targetIndex: i };
  }

  return undefined;
}

/**
 * Extract option values from args
 * Environment variables MCPC_VERBOSE and MCPC_JSON are used as defaults
 */
export function extractOptions(args: string[]): {
  config?: string;
  headers?: string[];
  timeout?: number;
  profile?: string;
  verbose: boolean;
  json: boolean;
} {
  const options = {
    verbose: args.includes('--verbose') || getVerboseFromEnv(),
    json: args.includes('--json') || args.includes('-j') || getJsonFromEnv(),
  };

  // Extract --config
  const configIndex = args.findIndex((arg) => arg === '--config' || arg === '-c');
  const config = configIndex >= 0 && configIndex + 1 < args.length ? args[configIndex + 1] : undefined;

  // Extract --header (can be repeated)
  const headers: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];
    if ((arg === '--header' || arg === '-H') && nextArg) {
      headers.push(nextArg);
    }
  }

  // Extract --timeout
  const timeoutIndex = args.findIndex((arg) => arg === '--timeout');
  const timeoutValue = timeoutIndex >= 0 && timeoutIndex + 1 < args.length ? args[timeoutIndex + 1] : undefined;
  const timeout = timeoutValue ? parseInt(timeoutValue, 10) : undefined;

  // Extract --profile
  const profileIndex = args.findIndex((arg) => arg === '--profile');
  const profile = profileIndex >= 0 && profileIndex + 1 < args.length ? args[profileIndex + 1] : undefined;

  return {
    ...options,
    ...(config && { config }),
    ...(headers.length > 0 && { headers }),
    ...(timeout !== undefined && { timeout }),
    ...(profile && { profile }),
  };
}

/**
 * Check if there's a command after the target in args
 */
export function hasCommandAfterTarget(args: string[]): boolean {
  // Start from index 2 (skip node and script path)
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    // Skip options and their values
    if (arg.startsWith('-')) {
      if (optionTakesValue(arg) && !arg.includes('=')) {
        i++; // Skip the value
      }
      continue;
    }

    // Found a non-option arg (this is a command)
    return true;
  }
  return false;
}

/**
 * Parse command arguments from --args flag
 * Supports three formats:
 * 1. Inline JSON: --args '{"key":"value"}'
 * 2. Key=value pairs: --args key=value
 * 3. Key:=json pairs: --args key:=123 enabled:=true
 *
 * @param args - Array of argument strings from --args flag
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

  // Parse key=value or key:=json pairs
  const parsedArgs: Record<string, unknown> = {};
  for (const pair of args) {
    if (pair.includes(':=')) {
      // Split only at the first occurrence of :=
      const colonEqualIndex = pair.indexOf(':=');
      const key = pair.substring(0, colonEqualIndex);
      const jsonValue = pair.substring(colonEqualIndex + 2);
      if (!key || jsonValue === undefined || jsonValue === '') {
        throw new ClientError(`Invalid argument format: ${pair}. Use key=value or key:=json`);
      }
      try {
        parsedArgs[key] = JSON.parse(jsonValue);
      } catch (error) {
        throw new ClientError(`Invalid JSON value for ${key}: ${(error as Error).message}`);
      }
    } else if (pair.includes('=')) {
      // Split only at the first occurrence of =
      const equalIndex = pair.indexOf('=');
      const key = pair.substring(0, equalIndex);
      const value = pair.substring(equalIndex + 1);
      if (!key || value === undefined) {
        throw new ClientError(`Invalid argument format: ${pair}. Use key=value or key:=json`);
      }
      parsedArgs[key] = value;
    } else {
      throw new ClientError(`Invalid argument format: ${pair}. Use key=value, key:=json, or inline JSON`);
    }
  }

  return parsedArgs;
}

/**
 * Load arguments from a JSON file
 *
 * @param filePath - Path to JSON file containing arguments
 * @returns Parsed arguments as key-value object
 * @throws ClientError if file cannot be read or contains invalid JSON
 */
export function loadArgsFromFile(filePath: string): Record<string, unknown> {
  const resolvedPath = resolvePath(filePath);

  let fileContent: string;
  try {
    fileContent = readFileSync(resolvedPath, 'utf-8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new ClientError(`Arguments file not found: ${filePath}`);
    }
    throw new ClientError(`Failed to read arguments file: ${err.message}`);
  }

  try {
    const parsed: unknown = JSON.parse(fileContent);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ClientError('Arguments file must contain a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ClientError) {
      throw error;
    }
    throw new ClientError(`Invalid JSON in arguments file: ${(error as Error).message}`);
  }
}
