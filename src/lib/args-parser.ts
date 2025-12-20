/**
 * Argument parsing utilities for CLI commands
 */

import { ClientError } from './errors.js';

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
