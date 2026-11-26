import { describe, expect, it } from 'vitest';
import { IpcLineBuffer, MAX_IPC_MESSAGE_CHARS } from '../../../src/lib/ipc-line-buffer.js';

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

  it('reports overflow only for the frame still being assembled', () => {
    const buffer = new IpcLineBuffer();
    const half = 'x'.repeat(MAX_IPC_MESSAGE_CHARS / 2 + 1);

    // Two complete frames that together exceed the cap are fine once drained
    buffer.append(`${half}\n${half}\n`);
    expect(buffer.drainLines()).toHaveLength(2);
    expect(buffer.overflowed).toBe(false);

    // One frame with no end in sight is not
    buffer.append(half);
    buffer.append(half);
    expect(buffer.drainLines()).toEqual([]);
    expect(buffer.overflowed).toBe(true);
  });
});
