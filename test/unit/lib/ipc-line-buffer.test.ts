import { describe, expect, it } from 'vitest';
import { IpcLineBuffer } from '../../../src/lib/ipc-line-buffer.js';

describe('IpcLineBuffer', () => {
  it('preserves a multibyte UTF-8 character split across socket chunks', () => {
    const input = '{"city":"München","status":"ready 🚀"}\n';
    const encoded = Buffer.from(input);
    const emojiStart = encoded.indexOf(Buffer.from('🚀'));
    const buffer = new IpcLineBuffer();

    buffer.append(encoded.subarray(0, emojiStart + 2));
    expect(buffer.drainLines()).toEqual([]);

    buffer.append(encoded.subarray(emojiStart + 2));
    expect(buffer.drainLines()).toEqual([input.trimEnd()]);
  });

  it('drains complete lines and retains a trailing partial frame', () => {
    const buffer = new IpcLineBuffer();

    buffer.append(Buffer.from('{"id":1}\n{"id":'));
    expect(buffer.drainLines()).toEqual(['{"id":1}']);

    buffer.append(Buffer.from('2}\n'));
    expect(buffer.drainLines()).toEqual(['{"id":2}']);
  });
});
