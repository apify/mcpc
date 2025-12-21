/**
 * File-based logger with rotation
 * Writes log messages to a file with automatic rotation based on size
 */

import { createWriteStream, type WriteStream } from 'fs';
import { stat, readdir, unlink, rename } from 'fs/promises';
import { join, dirname } from 'path';
import { ensureDir } from './utils.js';

export interface FileLoggerOptions {
  /** Path to the log file */
  filePath: string;
  /** Maximum file size in bytes before rotation (default: 10MB) */
  maxSize?: number;
  /** Maximum number of rotated files to keep (default: 5) */
  maxFiles?: number;
  /** Optional prefix for all log messages (e.g., session name) */
  prefix?: string;
}

/**
 * File logger with automatic rotation
 */
export class FileLogger {
  private filePath: string;
  private maxSize: number;
  private maxFiles: number;
  private prefix: string;
  private stream: WriteStream | null = null;
  private writtenBytes = 0;

  constructor(options: FileLoggerOptions) {
    this.filePath = options.filePath;
    this.maxSize = options.maxSize ?? 10 * 1024 * 1024; // 10MB default
    this.maxFiles = options.maxFiles ?? 5;
    this.prefix = options.prefix ? `[${options.prefix}] ` : '';
  }

  /**
   * Initialize the logger (create directory and open file stream)
   */
  async init(): Promise<void> {
    // Ensure directory exists
    const dir = dirname(this.filePath);
    await ensureDir(dir);

    // Check current file size
    try {
      const stats = await stat(this.filePath);
      this.writtenBytes = stats.size;

      // Rotate if already too large
      if (this.writtenBytes >= this.maxSize) {
        await this.rotate();
        this.writtenBytes = 0;
      }
    } catch {
      // File doesn't exist yet, that's fine
      this.writtenBytes = 0;
    }

    // Open file stream in append mode
    this.stream = createWriteStream(this.filePath, { flags: 'a' });

    // Handle stream errors
    this.stream.on('error', (error) => {
      console.error('[file-logger] Stream error:', error);
    });
  }

  /**
   * Write a log message
   */
  write(message: string): void {
    if (!this.stream) {
      console.error('[file-logger] Logger not initialized');
      return;
    }

    // Add prefix and ensure newline
    const prefixedMessage = this.prefix + message;
    const line = prefixedMessage.endsWith('\n') ? prefixedMessage : `${prefixedMessage}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');

    // Write to file
    this.stream.write(line);
    this.writtenBytes += bytes;

    // Check if rotation is needed
    if (this.writtenBytes >= this.maxSize) {
      // Rotate asynchronously (don't wait)
      void this.rotateAsync();
    }
  }

  /**
   * Rotate log files asynchronously
   */
  private async rotateAsync(): Promise<void> {
    try {
      await this.rotate();
      this.writtenBytes = 0;
    } catch (error) {
      console.error('[file-logger] Rotation error:', error);
    }
  }

  /**
   * Rotate log files
   * Renames current file to .1, .1 to .2, etc., and deletes oldest
   */
  private async rotate(): Promise<void> {
    // Close current stream
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }

    const dir = dirname(this.filePath);
    const basename = this.filePath;

    // Find all existing rotated files
    const rotatedFiles: { path: string; num: number }[] = [];
    try {
      const files = await readdir(dir);
      for (const file of files) {
        const fullPath = join(dir, file);
        // Match files like bridge-session.log.1, bridge-session.log.2, etc.
        if (fullPath.startsWith(basename + '.')) {
          const numStr = fullPath.substring(basename.length + 1);
          const num = parseInt(numStr, 10);
          if (!isNaN(num)) {
            rotatedFiles.push({ path: fullPath, num });
          }
        }
      }
    } catch {
      // Directory doesn't exist or can't read, that's fine
    }

    // Sort by number (descending)
    rotatedFiles.sort((a, b) => b.num - a.num);

    // Delete files beyond maxFiles-1 (we'll create .1, so keep maxFiles-1)
    for (const file of rotatedFiles) {
      if (file.num >= this.maxFiles) {
        try {
          await unlink(file.path);
        } catch {
          // Ignore errors
        }
      }
    }

    // Rename files: .1 -> .2, .2 -> .3, etc.
    for (const file of rotatedFiles) {
      if (file.num < this.maxFiles) {
        const newPath = `${basename}.${file.num + 1}`;
        try {
          await rename(file.path, newPath);
        } catch {
          // Ignore errors
        }
      }
    }

    // Rename current file to .1
    try {
      await rename(basename, `${basename}.1`);
    } catch {
      // If file doesn't exist, that's fine
    }

    // Create new stream
    this.stream = createWriteStream(this.filePath, { flags: 'a' });
    this.stream.on('error', (error) => {
      console.error('[file-logger] Stream error:', error);
    });
  }

  /**
   * Close the logger
   */
  async close(): Promise<void> {
    if (this.stream) {
      return new Promise((resolve) => {
        if (this.stream) {
          this.stream.end(() => {
            resolve();
          });
          this.stream = null;
        } else {
          resolve();
        }
      });
    }
  }
}
