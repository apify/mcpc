/**
 * Helpers for materializing MCP resource contents (`resources/read` results):
 * selecting which content item to use, decoding text/blob payloads to bytes,
 * and writing them to local files atomically.
 *
 * Shared by the CLI (`resources-read -o`, `--raw`) and the bridge process
 * (resource subscription sync) so both produce byte-identical files.
 */

import { stat, unlink, writeFile } from 'fs/promises';
import { basename, dirname, isAbsolute, join } from 'path';
import type { ReadResourceResult } from '@modelcontextprotocol/client';
import { atomicRename, ensureDir } from './utils.js';
import { ClientError, ServerError } from './errors.js';

/**
 * A resource content item decoded to bytes, ready to print or write.
 */
export interface DecodedResourceContent {
  /** URI of the selected content item (may differ from the requested URI). */
  uri: string;
  /** MIME type of the content, if provided by the server. */
  mimeType?: string;
  /** Decoded payload: UTF-8 bytes for `text` items, base64-decoded bytes for `blob` items. */
  data: Buffer;
  /** True when the item carried base64 `blob` (binary) content rather than `text`. */
  binary: boolean;
  /** Total number of content items in the result the item was selected from. */
  totalContents: number;
}

/**
 * Select and decode a single content item from a `resources/read` result.
 *
 * A read MAY return multiple content items (e.g. a directory URI expanding to
 * several files). For single-file materialization we pick the item whose `uri`
 * matches the requested URI, falling back to the first item. Callers that need
 * every item should consume the raw `ReadResourceResult` instead (`--json`).
 *
 * @throws ServerError when the result has no contents or an item carries neither `text` nor `blob`
 */
export function selectResourceContent(
  result: ReadResourceResult,
  requestedUri: string
): DecodedResourceContent {
  const first = result.contents[0];
  if (!first) {
    throw new ServerError(`Resource ${requestedUri} returned no contents`);
  }

  const item = result.contents.find((c) => c.uri === requestedUri) ?? first;

  let data: Buffer;
  let binary: boolean;
  if ('blob' in item && typeof item.blob === 'string') {
    data = Buffer.from(item.blob, 'base64');
    binary = true;
  } else if ('text' in item && typeof item.text === 'string') {
    data = Buffer.from(item.text, 'utf-8');
    binary = false;
  } else {
    throw new ServerError(`Resource ${requestedUri} returned a content item with no text or blob`);
  }

  return {
    uri: item.uri || requestedUri,
    ...(item.mimeType && { mimeType: item.mimeType }),
    data,
    binary,
    totalContents: result.contents.length,
  };
}

/**
 * Write resource content to a local file atomically (temp file + rename),
 * creating parent directories as needed. Overwrites an existing file — the
 * target is a materialized copy of the resource, not user-authored data.
 *
 * @param filePath - Absolute target path (callers resolve user input against
 *   their own cwd first — the bridge process has a different cwd than the CLI)
 * @throws ClientError when the path is not absolute or points at a directory
 */
export async function writeResourceFile(filePath: string, data: Buffer): Promise<void> {
  if (!isAbsolute(filePath)) {
    throw new ClientError(`Resource target path must be absolute: ${filePath}`);
  }

  // A directory at the target path cannot be replaced by rename — fail clearly.
  try {
    const existing = await stat(filePath);
    if (existing.isDirectory()) {
      throw new ClientError(`Resource target path is a directory: ${filePath}`);
    }
  } catch (error) {
    if (error instanceof ClientError) {
      throw error;
    }
    // ENOENT and friends: the write below surfaces any real problem
  }

  // User-chosen data directory, not mcpc state — standard permissions (umask
  // applies), not the 0700 default reserved for ~/.mcpc internals
  const dir = dirname(filePath);
  await ensureDir(dir, 0o777);

  // Temp file in the same directory so rename never crosses filesystems
  const tempFile = join(dir, `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tempFile, data);
    await atomicRename(tempFile, filePath);
  } catch (error) {
    await unlink(tempFile).catch(() => {});
    throw error;
  }
}
