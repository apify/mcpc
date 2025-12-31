/**
 * Resources command handlers
 */

import { formatOutput, formatSuccess } from '../output.js';
import { withMcpClient } from '../helpers.js';
import type { CommandOptions } from '../../lib/types.js';

/**
 * List available resources
 * Automatically fetches all pages if pagination is present
 */
export async function listResources(target: string, options: CommandOptions): Promise<void> {
  await withMcpClient(target, options, async (client, _context) => {
    // Fetch all resources across all pages
    const allResources = [];
    let cursor: string | undefined = undefined;

    do {
      const result = await client.listResources(cursor);
      allResources.push(...result.resources);
      cursor = result.nextCursor;
    } while (cursor);

    console.log(formatOutput(allResources, options.outputMode));
  });
}

/**
 * List available resource templates
 * Automatically fetches all pages if pagination is present
 */
export async function listResourceTemplates(target: string, options: CommandOptions): Promise<void> {
  await withMcpClient(target, options, async (client, _context) => {
    // Fetch all resource templates across all pages
    const allTemplates = [];
    let cursor: string | undefined = undefined;

    do {
      const result = await client.listResourceTemplates(cursor);
      allTemplates.push(...result.resourceTemplates);
      cursor = result.nextCursor;
    } while (cursor);

    console.log(formatOutput(allTemplates, options.outputMode));
  });
}

/**
 * Get a resource by URI
 */
export async function getResource(
  target: string,
  uri: string,
  options: CommandOptions & {
    output?: string;
    raw?: boolean;
    maxSize?: number;
  }
): Promise<void> {
  await withMcpClient(target, options, async (client, _context) => {
    const result = await client.readResource(uri);

    // If output file is specified, write to file
    if (options.output) {
      // TODO: Write resource contents to file
      throw new Error('--output flag not implemented yet');
    }

    // If raw mode, output just the content
    if (options.raw && result.contents.length > 0) {
      const firstContent = result.contents[0];
      if (firstContent) {
        if ('text' in firstContent && firstContent.text) {
          console.log(firstContent.text);
        } else if ('blob' in firstContent && firstContent.blob) {
          console.log(firstContent.blob);
        }
      }
      return;
    }

    console.log(formatOutput(result, options.outputMode));
  });
}

/**
 * Subscribe to resource updates
 */
export async function subscribeResource(target: string, uri: string, options: CommandOptions): Promise<void> {
  await withMcpClient(target, options, async (client, _context) => {
    await client.subscribeResource(uri);

    if (options.outputMode === 'human') {
      console.log(formatSuccess(`Subscribed to resource: ${uri}`));
    } else {
      console.log(formatOutput({ subscribed: true, uri }, 'json'));
    }
  });
}

/**
 * Unsubscribe from resource updates
 */
export async function unsubscribeResource(target: string, uri: string, options: CommandOptions): Promise<void> {
  await withMcpClient(target, options, async (client, _context) => {
    await client.unsubscribeResource(uri);

    if (options.outputMode === 'human') {
      console.log(formatSuccess(`Unsubscribed from resource: ${uri}`));
    } else {
      console.log(formatOutput({ unsubscribed: true, uri }, 'json'));
    }
  });
}
