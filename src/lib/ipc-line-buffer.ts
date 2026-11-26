import { StringDecoder } from 'node:string_decoder';

/**
 * Largest single IPC message (one newline-delimited JSON frame) either end accepts,
 * in UTF-16 code units as counted by `String.length`. Both ends refuse to *send* a
 * larger frame and answer with an ordinary error instead, so the receive-side cap,
 * which drops the connection, is only a memory backstop.
 */
export const MAX_IPC_MESSAGE_CHARS = 10 * 1024 * 1024;

/** Human-readable "<what> is too large" text shared by both ends of the socket. */
export function ipcMessageTooLargeText(what: string, chars: number): string {
  const megabytes = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${what} is too large for mcpc: ${megabytes(chars)}, limit ${megabytes(MAX_IPC_MESSAGE_CHARS)}`;
}

/**
 * Incrementally decodes UTF-8 IPC chunks and extracts newline-delimited frames.
 *
 * Buffer boundaries do not necessarily align with UTF-8 code points. Keeping one
 * decoder per connection prevents a split multibyte character from being replaced
 * before the complete JSON frame is assembled.
 */
export class IpcLineBuffer {
  private decoder = new StringDecoder('utf8');
  private buffer = '';

  append(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
  }

  /**
   * True when the frame still being assembled (what is left after `drainLines()`)
   * is already over the cap. Check it after draining: complete frames queued
   * behind each other must not count against a single frame's limit.
   */
  get overflowed(): boolean {
    return this.buffer.length > MAX_IPC_MESSAGE_CHARS;
  }

  drainLines(): string[] {
    const lines: string[] = [];
    let newlineIndex: number;

    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      lines.push(this.buffer.slice(0, newlineIndex));
      this.buffer = this.buffer.slice(newlineIndex + 1);
    }

    return lines;
  }

  clear(): void {
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
  }
}
