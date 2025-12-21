/**
 * Simple logging utility for mcpc
 * Respects verbose mode and provides consistent formatting
 */

import type { LogLevel } from './types.js';
import { FileLogger } from './file-logger.js';
import { getLogsDir } from './utils.js';
import { join } from 'path';

/**
 * Global verbose flag (set by CLI --verbose flag)
 */
let isVerbose = false;

/**
 * Global file logger instance (optional)
 */
let fileLogger: FileLogger | null = null;

/**
 * Set verbose mode
 */
export function setVerbose(verbose: boolean): void {
  isVerbose = verbose;
  // When verbose is enabled, set log level to debug to show all logs
  if (verbose) {
    currentLogLevel = 'debug';
  }
}

/**
 * Check if verbose mode is enabled
 */
export function getVerbose(): boolean {
  return isVerbose;
}

/**
 * Initialize file logger
 * @param logFileName - Name of the log file (e.g., 'cli.log', 'bridge.log')
 * @param prefix - Prefix for log messages (e.g., session name, target name)
 */
export async function initFileLogger(logFileName: string, prefix: string): Promise<void> {
  // Close existing logger if any
  if (fileLogger) {
    await fileLogger.close();
  }

  const logFilePath = join(getLogsDir(), logFileName);
  fileLogger = new FileLogger({
    filePath: logFilePath,
    maxSize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
    prefix,
  });

  await fileLogger.init();
}

/**
 * Close the file logger
 */
export async function closeFileLogger(): Promise<void> {
  if (fileLogger) {
    await fileLogger.close();
    fileLogger = null;
  }
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
 * Format a log message with timestamp and level
 * @param level - Log level
 * @param message - Log message
 * @param forFile - Whether formatting for file (always includes timestamp) or console (only in verbose)
 */
function formatMessage(level: LogLevel, message: string, forFile = false): string {
  const includeTimestamp = forFile || isVerbose;

  if (includeTimestamp) {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  }
  return message;
}

/**
 * Write a log message to file logger if configured
 */
function writeToFile(level: LogLevel, message: string, args: unknown[]): void {
  if (!fileLogger) return;

  // Format message for file with timestamp and level
  let fullMessage = formatMessage(level, message, true);

  // Append stringified args if any
  if (args.length > 0) {
    const argsStr = args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');
    fullMessage = `${fullMessage} ${argsStr}`;
  }

  fileLogger.write(fullMessage);
}

/**
 * Log a debug message (only in verbose mode)
 */
export function debug(message: string, ...args: unknown[]): void {
  if (shouldLog('debug')) {
    console.error(formatMessage('debug', message), ...args);
  }
  // Always write to file logger if configured, even if not shown to console
  writeToFile('debug', message, args);
}

/**
 * Log an info message to stderr to make it easy to separate program
 * output from diagnostic information
 */
export function info(message: string, ...args: unknown[]): void {
  if (shouldLog('info')) {
    console.error(formatMessage('info', message), ...args);
  }
  writeToFile('info', message, args);
}

/**
 * Log a warning message to stderr
 */
export function warn(message: string, ...args: unknown[]): void {
  if (shouldLog('warn')) {
    console.error(formatMessage('warn', message), ...args);
  }
  writeToFile('warn', message, args);
}

/**
 * Log an error message to stderr
 */
export function error(message: string, ...args: unknown[]): void {
  if (shouldLog('error')) {
    console.error(formatMessage('error', message), ...args);
  }
  writeToFile('error', message, args);
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

/**
 * No-op logger that doesn't output anything
 */
class NoOpLogger extends Logger {
  constructor() {
    super();
  }

  override debug(): void {}
  override info(): void {}
  override warn(): void {}
  override error(): void {}
  override log(): void {}
}

/**
 * Create a no-op logger that doesn't output anything
 */
export function createNoOpLogger(): Logger {
  return new NoOpLogger();
}
