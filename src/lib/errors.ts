/**
 * Custom error classes for mcpc with exit codes
 *
 * Exit codes:
 * - 0: Success
 * - 1: Client error (invalid arguments, command not found)
 * - 2: Server error (tool execution failed, resource not found)
 * - 3: Network error (connection failed, timeout)
 * - 4: Authentication error (invalid credentials, forbidden)
 */

/**
 * Base error class for all mcpc errors
 * Contains an exit code for CLI error handling
 */
export class McpError extends Error {
  public readonly code: number;
  public readonly details?: unknown;

  constructor(message: string, code: number, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;

    // Maintains proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Convert error to JSON format for --json output
   */
  toJSON(): Record<string, unknown> {
    return {
      error: this.name,
      message: this.message,
      code: this.code,
      details: this.details,
    };
  }
}

/**
 * Client error (exit code 1)
 * Used for invalid arguments, unknown commands, validation errors, etc.
 */
export class ClientError extends McpError {
  constructor(message: string, details?: unknown) {
    super(message, 1, details);
  }
}

/**
 * Server error (exit code 2)
 * Used for MCP server errors, tool execution failures, resource not found, etc.
 */
export class ServerError extends McpError {
  constructor(message: string, details?: unknown) {
    super(message, 2, details);
  }
}

/**
 * Network error (exit code 3)
 * Used for connection failures, timeouts, DNS errors, etc.
 */
export class NetworkError extends McpError {
  constructor(message: string, details?: unknown) {
    super(message, 3, details);
  }
}

/**
 * Authentication error (exit code 4)
 * Used for invalid credentials, forbidden access, token expiry, etc.
 */
export class AuthError extends McpError {
  constructor(message: string, details?: unknown) {
    super(message, 4, details);
  }
}

/**
 * Type guard to check if an error is an McpError
 */
export function isMcpError(error: unknown): error is McpError {
  return error instanceof McpError;
}

/**
 * Convert any error to an McpError
 * Unknown errors become ClientError with code 1
 */
export function toMcpError(error: unknown): McpError {
  if (isMcpError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new ClientError(error.message, { originalError: error.name });
  }

  return new ClientError(String(error));
}

/**
 * Format error for display to user
 */
export function formatError(error: unknown, verbose = false): string {
  const mcpError = toMcpError(error);

  let output = `Error: ${mcpError.message}`;

  if (verbose && mcpError.details) {
    output += `\n\nDetails:\n${JSON.stringify(mcpError.details, null, 2)}`;
  }

  if (verbose && mcpError.stack) {
    output += `\n\nStack trace:\n${mcpError.stack}`;
  }

  return output;
}
