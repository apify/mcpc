/**
 * Resources command handlers
 */

import chalk from 'chalk';
import { formatOutput, formatSuccess, formatWarning, formatResourceContents } from '../output.js';
import { withMcpClient } from '../helpers.js';
import { resolvePath, fetchAllPages } from '../../lib/utils.js';
import { selectResourceContent, writeResourceFile } from '../../lib/resource-content.js';
import { ClientError } from '../../lib/errors.js';
import type { CommandOptions } from '../../lib/types.js';

/**
 * List available resources
 * Automatically fetches all pages if pagination is present
 */
export async function listResources(target: string, options: CommandOptions): Promise<void> {
  await withMcpClient(target, options, async (client, _context) => {
    // Fetch all resources across all pages
    const allResources = await fetchAllPages(
      (cursor) => client.listResources(cursor),
      (page) => page.resources
    );

    console.log(
      formatOutput(allResources, options.outputMode, {
        ...(options.maxChars && { maxChars: options.maxChars }),
      })
    );
  });
}

/**
 * List available resource templates
 * Automatically fetches all pages if pagination is present
 */
export async function listResourceTemplates(
  target: string,
  options: CommandOptions
): Promise<void> {
  await withMcpClient(target, options, async (client, _context) => {
    // Fetch all resource templates across all pages
    const allTemplates = await fetchAllPages(
      (cursor) => client.listResourceTemplates(cursor),
      (page) => page.resourceTemplates
    );

    console.log(
      formatOutput(allTemplates, options.outputMode, {
        ...(options.maxChars && { maxChars: options.maxChars }),
      })
    );
  });
}

/**
 * Read a resource by URI.
 *
 * Output modes:
 * - default (human): pretty view; binary (blob) content is summarized, never dumped
 * - --raw: bare content to stdout for piping; binary requires a redirect (or -o)
 * - -o <file>: save the content to a file, decoding base64 blobs to bytes
 * - --json: full MCP ReadResourceResult (with -o: a small summary object instead)
 */
export async function getResource(
  target: string,
  uri: string,
  options: CommandOptions & {
    output?: string;
    raw?: boolean;
  }
): Promise<void> {
  // --raw output must stay bare for piping — suppress the [session] prefix line
  const clientOptions = options.raw && !options.output ? { ...options, hideTarget: true } : options;

  await withMcpClient(target, clientOptions, async (client, _context) => {
    const result = await client.readResource(uri);

    // -o/--output: write the resource to a local file (binary-safe)
    if (options.output) {
      const filePath = resolvePath(options.output);
      const content = selectResourceContent(result, uri);
      await writeResourceFile(filePath, content.data);

      const mimeSuffix = content.mimeType ? `, ${content.mimeType}` : '';
      if (options.outputMode === 'json') {
        console.log(
          formatOutput(
            {
              uri,
              file: filePath,
              bytes: content.data.length,
              ...(content.mimeType && { mimeType: content.mimeType }),
            },
            'json'
          )
        );
      } else {
        console.log(
          formatSuccess(`Saved ${uri} to ${filePath} (${content.data.length} bytes${mimeSuffix})`)
        );
        if (content.totalContents > 1) {
          console.log(
            formatWarning(
              `Resource returned ${content.totalContents} content items; saved only ${content.uri}. Use --json to see all items.`
            )
          );
        }
      }
      return;
    }

    // --json: full MCP result (takes precedence over --raw, same as skills-get)
    if (options.outputMode === 'json') {
      console.log(formatOutput(result, 'json'));
      return;
    }

    // --raw: bare content for piping
    if (options.raw) {
      const content = selectResourceContent(result, uri);
      if (content.binary) {
        if (process.stdout.isTTY) {
          throw new ClientError(
            `Binary content (${content.mimeType || 'unknown type'}, ${content.data.length} bytes) would mess up the terminal.\n` +
              `Redirect stdout (mcpc ${target} resources-read ${uri} --raw > file) or save with -o <file>.`
          );
        }
        process.stdout.write(content.data);
      } else {
        console.log(content.data.toString('utf-8'));
      }
      return;
    }

    console.log(
      formatResourceContents(uri, result, {
        sessionName: target,
        ...(options.maxChars && { maxChars: options.maxChars }),
      })
    );
  });
}

/**
 * Subscribe to a resource and keep a local file in sync with it.
 *
 * Downloads the resource to the file now; afterwards the session bridge rewrites
 * the file whenever the server sends notifications/resources/updated for the URI
 * (per the MCP spec the notification carries no content, so the bridge re-reads).
 */
export async function subscribeResource(
  target: string,
  uri: string,
  file: string,
  options: CommandOptions
): Promise<void> {
  // Resolve against the CLI's cwd — the bridge process has a different cwd
  const filePath = resolvePath(file);

  await withMcpClient(target, options, async (client, _context) => {
    const result = await client.subscribeResource(uri, filePath);

    if (options.outputMode === 'human') {
      const mimeSuffix = result.mimeType ? `, ${result.mimeType}` : '';
      console.log(formatSuccess(`Subscribed to resource: ${uri}`));
      console.log(`Synced to ${result.file} (${result.bytes} bytes${mimeSuffix})`);
      console.log(chalk.dim('The file is updated automatically while the session is connected.'));
      console.log(chalk.dim(`To check sync status, run: mcpc ${target}`));
      console.log(
        chalk.dim(
          `To stop syncing (keeps the file), run: mcpc ${target} resources-unsubscribe ${uri}`
        )
      );
    } else {
      console.log(formatOutput({ subscribed: true, ...result }, 'json'));
    }
  });
}

/**
 * Stop syncing a subscribed resource. The synced local file is kept as-is.
 */
export async function unsubscribeResource(
  target: string,
  uri: string,
  options: CommandOptions
): Promise<void> {
  await withMcpClient(target, options, async (client, _context) => {
    const result = await client.unsubscribeResource(uri);

    if (options.outputMode === 'human') {
      console.log(formatSuccess(`Unsubscribed from resource: ${uri}`));
      console.log(`  File kept: ${result.file}`);
    } else {
      console.log(formatOutput({ unsubscribed: true, ...result }, 'json'));
    }
  });
}
