/**
 * Unit tests for the bridge's ResourceSyncManager (resource→file sync)
 */

import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { ResourceSyncManager } from '../../../src/bridge/resource-sync.js';
import type { ResourceSubscriptionEntry } from '../../../src/lib/types.js';
import { ClientError } from '../../../src/lib/errors.js';
import { createNoOpLogger } from '../../../src/lib/logger.js';

const URI = 'test://resource';

function textResult(text: string): ReadResourceResult {
  return { contents: [{ uri: URI, mimeType: 'text/plain', text }] };
}

interface Harness {
  manager: ResourceSyncManager;
  reads: string[];
  persisted: Record<string, ResourceSubscriptionEntry>[];
  setContent: (text: string) => void;
  failReads: (message: string | null) => void;
  setReadDelay: (ms: number) => void;
}

function createHarness(initialContent = 'v1'): Harness {
  let content = initialContent;
  let failMessage: string | null = null;
  let readDelay = 0;
  const reads: string[] = [];
  const persisted: Record<string, ResourceSubscriptionEntry>[] = [];

  const manager = new ResourceSyncManager({
    readResource: async (uri) => {
      reads.push(uri);
      if (readDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, readDelay));
      }
      if (failMessage) {
        throw new Error(failMessage);
      }
      return textResult(content);
    },
    persist: async (entries) => {
      persisted.push(structuredClone(entries));
    },
    logger: createNoOpLogger(),
  });

  return {
    manager,
    reads,
    persisted,
    setContent: (text) => {
      content = text;
    },
    failReads: (message) => {
      failMessage = message;
    },
    setReadDelay: (ms) => {
      readDelay = ms;
    },
  };
}

describe('ResourceSyncManager', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mcpc-resource-sync-'));
    filePath = join(dir, 'synced.txt');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('add() performs the initial sync and persists the entry', async () => {
    const h = createHarness('hello');
    const result = await h.manager.add(URI, filePath);

    expect(result).toEqual({ uri: URI, file: filePath, bytes: 5, mimeType: 'text/plain' });
    expect(await readFile(filePath, 'utf-8')).toBe('hello');
    expect(h.manager.has(URI)).toBe(true);
    expect(h.persisted.at(-1)?.[URI]?.filePath).toBe(filePath);
    expect(h.persisted.at(-1)?.[URI]?.lastSyncedAt).toBeDefined();
  });

  it('add() throws and registers nothing when the initial sync fails', async () => {
    const h = createHarness();
    h.failReads('read refused');

    await expect(h.manager.add(URI, filePath)).rejects.toThrow('read refused');
    expect(h.manager.has(URI)).toBe(false);
    expect(h.persisted).toHaveLength(0);
  });

  it('handleUpdated() re-syncs the file with new content', async () => {
    const h = createHarness('v1');
    await h.manager.add(URI, filePath);

    h.setContent('v2');
    h.manager.handleUpdated(URI);
    await h.manager.waitForIdle();

    expect(await readFile(filePath, 'utf-8')).toBe('v2');
    expect(h.persisted.at(-1)?.[URI]?.lastSyncedAt).toBeDefined();
  });

  it('handleUpdated() ignores unsubscribed URIs', async () => {
    const h = createHarness();
    h.manager.handleUpdated('test://unknown');
    await h.manager.waitForIdle();
    expect(h.reads).toHaveLength(0);
  });

  it('coalesces bursts of update notifications into at most one follow-up sync', async () => {
    const h = createHarness('v1');
    await h.manager.add(URI, filePath);
    expect(h.reads).toHaveLength(1);

    h.setReadDelay(30);
    h.setContent('v2');
    h.manager.handleUpdated(URI);
    h.manager.handleUpdated(URI);
    h.manager.handleUpdated(URI);
    await h.manager.waitForIdle();

    // 1 initial read + 1 in-flight sync + 1 coalesced follow-up = 3
    expect(h.reads).toHaveLength(3);
    expect(await readFile(filePath, 'utf-8')).toBe('v2');
  });

  it('records lastError when a re-sync fails and clears it on the next success', async () => {
    const h = createHarness('v1');
    await h.manager.add(URI, filePath);

    h.failReads('boom');
    h.manager.handleUpdated(URI);
    await h.manager.waitForIdle();
    expect(h.persisted.at(-1)?.[URI]?.lastError).toContain('boom');
    // File keeps the last good content
    expect(await readFile(filePath, 'utf-8')).toBe('v1');

    h.failReads(null);
    h.setContent('v2');
    h.manager.handleUpdated(URI);
    await h.manager.waitForIdle();
    expect(h.persisted.at(-1)?.[URI]?.lastError).toBeUndefined();
    expect(await readFile(filePath, 'utf-8')).toBe('v2');
  });

  it('remove() deletes the entry, persists, and keeps the file', async () => {
    const h = createHarness('keep me');
    await h.manager.add(URI, filePath);

    const removed = await h.manager.remove(URI);
    expect(removed.filePath).toBe(filePath);
    expect(h.manager.has(URI)).toBe(false);
    expect(h.persisted.at(-1)).toEqual({});
    expect(await readFile(filePath, 'utf-8')).toBe('keep me');

    // Updates after removal are ignored
    h.manager.handleUpdated(URI);
    await h.manager.waitForIdle();
    expect(h.reads).toHaveLength(1);
  });

  it('remove() throws ClientError for unknown URIs and lists active subscriptions', async () => {
    const h = createHarness();
    await h.manager.add(URI, filePath);

    await expect(h.manager.remove('test://unknown')).rejects.toThrow(ClientError);
    await expect(h.manager.remove('test://unknown')).rejects.toThrow(URI);
  });

  it('add() for an already-subscribed URI re-targets the file', async () => {
    const h = createHarness('v1');
    await h.manager.add(URI, filePath);

    const otherPath = join(dir, 'other.txt');
    await h.manager.add(URI, otherPath);
    expect(await readFile(otherPath, 'utf-8')).toBe('v1');
    expect(h.manager.list()).toHaveLength(1);
    expect(h.manager.list()[0]?.filePath).toBe(otherPath);
  });

  it('load() restores persisted entries and resync() refreshes the file', async () => {
    const h = createHarness('restored');
    const entry: ResourceSubscriptionEntry = {
      uri: URI,
      filePath,
      subscribedAt: new Date().toISOString(),
    };
    h.manager.load({ [URI]: entry });

    expect(h.manager.has(URI)).toBe(true);
    await h.manager.resync(URI);
    expect(await readFile(filePath, 'utf-8')).toBe('restored');
  });

  it('recordError() stores the error on the entry', async () => {
    const h = createHarness();
    await h.manager.add(URI, filePath);

    await h.manager.recordError(URI, 'Re-subscribe failed: nope');
    expect(h.persisted.at(-1)?.[URI]?.lastError).toBe('Re-subscribe failed: nope');
  });
});
