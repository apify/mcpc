import { StringDecoder } from 'node:string_decoder';

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

  get length(): number {
    return this.buffer.length;
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
