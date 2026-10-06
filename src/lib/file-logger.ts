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
}

/**
 * File logger with automatic rotation
 */
/**
 * End a write stream and wait until its file descriptor is closed. `end()`'s callback
 * runs on `finish`, before the descriptor is released; renaming the file at that point
 * still races the open handle (and is refused on Windows), so wait for `close` instead.
 */
function endAndClose(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.closed) {
      resolve();
      return;
    }
    stream.once('close', () => resolve());
    stream.end();
  });
}

export class FileLogger {
  private filePath: string;
  private maxSize: number;
  private maxFiles: number;
  private stream: WriteStream | null = null;
  private writtenBytes = 0;
  /** The rotation in progress, if any; writes made meanwhile wait in `pendingLines` */
  private rotation: Promise<void> | null = null;
  private pendingLines: string[] = [];

  constructor(options: FileLoggerOptions) {
    this.filePath = options.filePath;
    this.maxSize = options.maxSize ?? 10 * 1024 * 1024; // 10MB default
    this.maxFiles = options.maxFiles ?? 5;
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

    // Open file stream in append mode. Logs hold server output and request details, so
    // they are created owner-only (the mode applies on creation; the logs dir is 0700).
    this.stream = createWriteStream(this.filePath, { flags: 'a', mode: 0o600 });

    // Handle stream errors
    this.stream.on('error', (error) => {
      console.error('[file-logger] Stream error:', error);
    });
  }

  /**
   * Write a log message
   */
  write(message: string): void {
    // Ensure newline
    const line = message.endsWith('\n') ? message : `${message}\n`;

    // A rotation closes the stream, renames the files and opens a new one; lines logged
    // meanwhile are held back and written to the new file once it is open.
    if (this.rotation) {
      this.pendingLines.push(line);
      return;
    }

    if (!this.stream) {
      console.error('[file-logger] Logger not initialized');
      return;
    }

    // Write to file
    this.stream.write(line);
    this.writtenBytes += Buffer.byteLength(line, 'utf8');

    // Check if rotation is needed
    if (this.writtenBytes >= this.maxSize) {
      // Rotate asynchronously (don't wait)
      this.rotation = this.rotateAsync();
    }
  }

  /**
   * Rotate log files asynchronously, then flush the lines that arrived meanwhile
   */
  private async rotateAsync(): Promise<void> {
    try {
      await this.rotate();
      this.writtenBytes = 0;
    } catch (error) {
      console.error('[file-logger] Rotation error:', error);
    } finally {
      this.rotation = null;
      // Flush in order; a flushed line may start the next rotation, which then holds
      // back the rest the same way.
      const pending = this.pendingLines;
      this.pendingLines = [];
      for (const line of pending) {
        this.write(line);
      }
    }
  }

  /**
   * Rotate log files
   * Renames current file to .1, .1 to .2, etc., and deletes oldest
   */
  private async rotate(): Promise<void> {
    // Close the current stream and wait until its descriptor is released: write streams
    // open lazily and flush on end, so renaming before that could run while the file does
    // not exist yet (the rename then silently did nothing and the rotation was lost),
    // before the last lines reached it, or against a still-open handle.
    if (this.stream) {
      const stream = this.stream;
      this.stream = null;
      await endAndClose(stream);
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
    this.stream = createWriteStream(this.filePath, { flags: 'a', mode: 0o600 });
    this.stream.on('error', (error) => {
      console.error('[file-logger] Stream error:', error);
    });
  }

  /**
   * Close the logger
   */
  async close(): Promise<void> {
    // Let a rotation in progress finish and flush (a flush may start another one)
    while (this.rotation) {
      await this.rotation;
    }
    if (!this.stream) {
      return;
    }
    const stream = this.stream;
    this.stream = null;
    await endAndClose(stream);
  }
}
