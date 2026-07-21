/**
 * Resource→file sync for the bridge process.
 *
 * Tracks resource subscriptions created with `resources-subscribe <uri> <file>`.
 * For each subscription the bridge keeps a local file in sync with the server
 * resource: an initial download on subscribe, then a re-read + rewrite whenever
 * the server sends `notifications/resources/updated` for the URI (per the MCP
 * spec the notification carries no content — the client re-reads the resource).
 *
 * Subscriptions are persisted to sessions.json (via the injected `persist`
 * callback) so they survive bridge restarts; the bridge re-subscribes and
 * re-syncs on startup.
 */

import type { ReadResourceResult } from '@modelcontextprotocol/client';
import type { ResourceSubscriptionEntry, ResourceSyncResult } from '../lib/types.js';
import { selectResourceContent, writeResourceFile } from '../lib/resource-content.js';
import { ClientError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

/**
 * Dependencies injected by the bridge (kept as callbacks for testability)
 */
export interface ResourceSyncManagerOptions {
  /** Read a resource from the MCP server (bridge wires this to McpClient.readResource) */
  readResource: (uri: string) => Promise<ReadResourceResult>;
  /** Persist the full subscriptions map (bridge wires this to updateSession) */
  persist: (entries: Record<string, ResourceSubscriptionEntry>) => Promise<void>;
  logger: Logger;
}

export class ResourceSyncManager {
  private entries = new Map<string, ResourceSubscriptionEntry>();
  // In-flight sync per URI, with a coalescing flag for updates arriving mid-sync:
  // any number of notifications during a sync collapse into exactly one follow-up sync.
  private inFlight = new Map<string, Promise<void>>();
  private pendingResync = new Set<string>();

  constructor(private options: ResourceSyncManagerOptions) {}

  /**
   * Load persisted subscriptions (from sessions.json) on bridge startup.
   * Does not touch the server or the files — see resync() for that.
   */
  load(entries: Record<string, ResourceSubscriptionEntry> | undefined): void {
    if (!entries) return;
    for (const [uri, entry] of Object.entries(entries)) {
      this.entries.set(uri, { ...entry });
    }
  }

  list(): ResourceSubscriptionEntry[] {
    return [...this.entries.values()];
  }

  has(uri: string): boolean {
    return this.entries.has(uri);
  }

  /**
   * Register a subscription and perform the initial sync.
   * On initial sync failure, throws without registering anything (the caller
   * rolls back the server-side subscription).
   * Re-subscribing an already-subscribed URI just changes the target file.
   */
  async add(uri: string, filePath: string): Promise<ResourceSyncResult> {
    const result = await this.syncToFile(uri, filePath);
    const now = new Date().toISOString();
    this.entries.set(uri, {
      uri,
      filePath,
      subscribedAt: this.entries.get(uri)?.subscribedAt ?? now,
      lastSyncedAt: now,
    });
    await this.persist();
    return result;
  }

  /**
   * Remove a subscription; the synced file is kept as-is.
   * @returns the removed entry (so callers can report the kept file path)
   * @throws ClientError when the URI has no active subscription
   */
  async remove(uri: string): Promise<ResourceSubscriptionEntry> {
    const entry = this.entries.get(uri);
    if (!entry) {
      const active = this.list().map((e) => e.uri);
      throw new ClientError(
        `No active subscription for ${uri}.` +
          (active.length > 0
            ? `\nActive subscriptions:\n${active.map((u) => `  ${u}`).join('\n')}`
            : ' This session has no resource subscriptions.')
      );
    }
    this.entries.delete(uri);
    this.pendingResync.delete(uri);
    await this.persist();
    return entry;
  }

  /**
   * Handle a `notifications/resources/updated` notification: re-sync the file
   * in the background. Notifications for unsubscribed URIs are ignored; bursts
   * of notifications coalesce into at most one queued re-sync.
   */
  handleUpdated(uri: string): void {
    if (!this.entries.has(uri)) {
      this.options.logger.debug(`Ignoring resources/updated for unsubscribed URI: ${uri}`);
      return;
    }
    if (this.inFlight.has(uri)) {
      this.pendingResync.add(uri);
      return;
    }
    this.startSync(uri);
  }

  /**
   * Re-sync a subscribed resource now, recording lastError/lastSyncedAt on the
   * entry instead of throwing. Used on bridge startup after re-subscribing.
   */
  async resync(uri: string): Promise<void> {
    await this.runSync(uri);
  }

  /**
   * Record a subscription-level error (e.g. re-subscribe rejected by the server
   * after a bridge restart) so `mcpc @session` can surface it.
   */
  async recordError(uri: string, message: string): Promise<void> {
    const entry = this.entries.get(uri);
    if (!entry) return;
    entry.lastError = message;
    await this.persist();
  }

  /**
   * Wait until all in-flight (and coalesced follow-up) syncs settle.
   * @internal for tests
   */
  async waitForIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
  }

  private startSync(uri: string): void {
    const promise = this.runSync(uri).finally(() => {
      this.inFlight.delete(uri);
      // An update arrived while syncing — run one more sync to pick it up
      if (this.pendingResync.delete(uri) && this.entries.has(uri)) {
        this.startSync(uri);
      }
    });
    this.inFlight.set(uri, promise);
  }

  private async runSync(uri: string): Promise<void> {
    const entry = this.entries.get(uri);
    if (!entry) return;
    try {
      const result = await this.syncToFile(uri, entry.filePath);
      entry.lastSyncedAt = new Date().toISOString();
      delete entry.lastError;
      this.options.logger.info(
        `Resource synced: ${uri} -> ${entry.filePath} (${result.bytes} bytes)`
      );
    } catch (error) {
      entry.lastError = (error as Error).message;
      this.options.logger.warn(`Failed to sync resource ${uri} to ${entry.filePath}:`, error);
    }
    await this.persist().catch((error) => {
      this.options.logger.warn('Failed to persist resource subscriptions:', error);
    });
  }

  private async syncToFile(uri: string, filePath: string): Promise<ResourceSyncResult> {
    const result = await this.options.readResource(uri);
    const content = selectResourceContent(result, uri);
    await writeResourceFile(filePath, content.data);
    return {
      uri,
      file: filePath,
      bytes: content.data.length,
      ...(content.mimeType && { mimeType: content.mimeType }),
    };
  }

  private async persist(): Promise<void> {
    const record: Record<string, ResourceSubscriptionEntry> = {};
    for (const [uri, entry] of this.entries) {
      record[uri] = entry;
    }
    await this.options.persist(record);
  }
}
