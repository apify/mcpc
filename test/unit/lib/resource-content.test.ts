/**
 * Unit tests for resource content selection/decoding and file writing
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { selectResourceContent, writeResourceFile } from '../../../src/lib/resource-content.js';
import { ClientError, ServerError } from '../../../src/lib/errors.js';

describe('selectResourceContent', () => {
  it('decodes a single text content item', () => {
    const result: ReadResourceResult = {
      contents: [{ uri: 'test://a', mimeType: 'text/plain', text: 'hello' }],
    };
    const content = selectResourceContent(result, 'test://a');
    expect(content.uri).toBe('test://a');
    expect(content.mimeType).toBe('text/plain');
    expect(content.binary).toBe(false);
    expect(content.data.toString('utf-8')).toBe('hello');
    expect(content.totalContents).toBe(1);
  });

  it('decodes a base64 blob content item to bytes', () => {
    const bytes = Buffer.from([0x00, 0x01, 0xfe, 0xff]);
    const result: ReadResourceResult = {
      contents: [
        { uri: 'test://bin', mimeType: 'application/octet-stream', blob: bytes.toString('base64') },
      ],
    };
    const content = selectResourceContent(result, 'test://bin');
    expect(content.binary).toBe(true);
    expect(Buffer.compare(content.data, bytes)).toBe(0);
  });

  it('prefers the content item matching the requested URI', () => {
    const result: ReadResourceResult = {
      contents: [
        { uri: 'test://other', text: 'other' },
        { uri: 'test://wanted', text: 'wanted' },
      ],
    };
    const content = selectResourceContent(result, 'test://wanted');
    expect(content.uri).toBe('test://wanted');
    expect(content.data.toString('utf-8')).toBe('wanted');
    expect(content.totalContents).toBe(2);
  });

  it('falls back to the first content item when no URI matches', () => {
    const result: ReadResourceResult = {
      contents: [
        { uri: 'test://first', text: 'first' },
        { uri: 'test://second', text: 'second' },
      ],
    };
    const content = selectResourceContent(result, 'test://nomatch');
    expect(content.uri).toBe('test://first');
  });

  it('throws ServerError when the result has no contents', () => {
    expect(() => selectResourceContent({ contents: [] }, 'test://x')).toThrow(ServerError);
  });

  it('throws ServerError when a content item has neither text nor blob', () => {
    const result = { contents: [{ uri: 'test://x' }] } as unknown as ReadResourceResult;
    expect(() => selectResourceContent(result, 'test://x')).toThrow(ServerError);
  });

  it('treats text content with mimeType missing as text', () => {
    const result: ReadResourceResult = { contents: [{ uri: 'test://a', text: 'no mime' }] };
    const content = selectResourceContent(result, 'test://a');
    expect(content.mimeType).toBeUndefined();
    expect(content.binary).toBe(false);
  });
});

describe('writeResourceFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpc-resource-content-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes data to the target file', async () => {
    const target = join(dir, 'out.txt');
    await writeResourceFile(target, Buffer.from('content'));
    expect(await readFile(target, 'utf-8')).toBe('content');
  });

  it('writes binary data byte-exact', async () => {
    const target = join(dir, 'out.bin');
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    await writeResourceFile(target, bytes);
    expect(Buffer.compare(await readFile(target), bytes)).toBe(0);
  });

  it('overwrites an existing file', async () => {
    const target = join(dir, 'out.txt');
    await writeFile(target, 'old');
    await writeResourceFile(target, Buffer.from('new'));
    expect(await readFile(target, 'utf-8')).toBe('new');
  });

  it('creates missing parent directories', async () => {
    const target = join(dir, 'nested', 'deeper', 'out.txt');
    await writeResourceFile(target, Buffer.from('nested'));
    expect(await readFile(target, 'utf-8')).toBe('nested');
  });

  it('rejects relative paths', async () => {
    await expect(writeResourceFile('relative/out.txt', Buffer.from('x'))).rejects.toThrow(
      ClientError
    );
  });

  it('rejects a target path that is a directory', async () => {
    const target = join(dir, 'subdir');
    await mkdir(target);
    await expect(writeResourceFile(target, Buffer.from('x'))).rejects.toThrow(ClientError);
  });

  it('leaves no temp files behind on success', async () => {
    const target = join(dir, 'out.txt');
    await writeResourceFile(target, Buffer.from('content'));
    const { readdir } = await import('fs/promises');
    const files = await readdir(dir);
    expect(files).toEqual(['out.txt']);
  });
});
