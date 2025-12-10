/**
 * Simple logging utility for mcpc
 * Respects verbose mode and provides consistent formatting
 */

import type { LogLevel } from './types.js';

/**
 * Global verbose flag (set by CLI --verbose flag)
 */
let isVerbose = false;

/**
 * Set verbose mode
 */
export function setVerbose(verbose: boolean): void {
  isVerbose = verbose;
}

/**
 * Check if verbose mode is enabled
 */
export function getVerbose(): boolean {
  return isVerbose;
}

/**
 * Log levels with numeric priority
 */
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Current log level (debug only shown in verbose mode)
 */
let currentLogLevel: LogLevel = 'info';

/**
 * Set the current log level
 */
export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

/**
 * Check if a message at the given level should be logged
 */
function shouldLog(level: LogLevel): boolean {
  // Debug logs only shown in verbose mode
  if (level === 'debug' && !isVerbose) {
    return false;
  }

  return LOG_LEVELS[level] >= LOG_LEVELS[currentLogLevel];
}

/**
 * Format a log message with timestamp (if verbose)
 */
function formatMessage(level: LogLevel, message: string): string {
  if (isVerbose) {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  }
  return message;
}

/**
 * Log a debug message (only in verbose mode)
 */
export function debug(message: string, ...args: unknown[]): void {
  if (shouldLog('debug')) {
    console.error(formatMessage('debug', message), ...args);
  }
}

/**
 * Log an info message to stdout
 */
export function info(message: string, ...args: unknown[]): void {
  if (shouldLog('info')) {
    console.log(formatMessage('info', message), ...args);
  }
}

/**
 * Log a warning message to stderr
 */
export function warn(message: string, ...args: unknown[]): void {
  if (shouldLog('warn')) {
    console.error(formatMessage('warn', message), ...args);
  }
}

/**
 * Log an error message to stderr
 */
export function error(message: string, ...args: unknown[]): void {
  if (shouldLog('error')) {
    console.error(formatMessage('error', message), ...args);
  }
}

/**
 * Log function that accepts a log level
 */
export function log(level: LogLevel, message: string, ...args: unknown[]): void {
  switch (level) {
    case 'debug':
      debug(message, ...args);
      break;
    case 'info':
      info(message, ...args);
      break;
    case 'warn':
      warn(message, ...args);
      break;
    case 'error':
      error(message, ...args);
      break;
  }
}

/**
 * Simple logger class for consistent logging
 */
export class Logger {
  constructor(private readonly context?: string) {}

  private formatContext(message: string): string {
    return this.context ? `[${this.context}] ${message}` : message;
  }

  debug(message: string, ...args: unknown[]): void {
    debug(this.formatContext(message), ...args);
  }

  info(message: string, ...args: unknown[]): void {
    info(this.formatContext(message), ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    warn(this.formatContext(message), ...args);
  }

  error(message: string, ...args: unknown[]): void {
    error(this.formatContext(message), ...args);
  }

  log(level: LogLevel, message: string, ...args: unknown[]): void {
    log(level, this.formatContext(message), ...args);
  }
}

/**
 * Create a logger with a specific context
 */
export function createLogger(context: string): Logger {
  return new Logger(context);
}
