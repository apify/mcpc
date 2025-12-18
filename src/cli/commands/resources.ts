/**
 * Resources command handlers
 */

import type { OutputMode } from '../../lib/types.js';
import { formatOutput, formatSuccess, logTarget } from '../output.js';
import { withMcpClient } from '../helpers.js';

/**
 * List available resources
 */
export async function listResources(
  target: string,
  options: {
    cursor?: string;
    outputMode: OutputMode;
    config?: string;
    headers?: string[];
    timeout?: number;
    verbose?: boolean;
  }
): Promise<void> {
  await withMcpClient(target, options, async (client) => {
    const result = await client.listResources(options.cursor);

    logTarget(target, options.outputMode);
    console.log(formatOutput(result.resources, options.outputMode));

    // Show pagination info if there's a next cursor
    if (result.nextCursor && options.outputMode === 'human') {
      console.log(`\nMore resources available. Use --cursor "${result.nextCursor}" to see more.`);
    }
  });
}

/**
 * List available resource templates
 */
export async function listResourceTemplates(
  target: string,
  options: {
    cursor?: string;
    outputMode: OutputMode;
    config?: string;
    headers?: string[];
    timeout?: number;
    verbose?: boolean;
  }
): Promise<void> {
  await withMcpClient(target, options, async (client) => {
    const result = await client.listResourceTemplates(options.cursor);

    logTarget(target, options.outputMode);
    console.log(formatOutput(result.resourceTemplates, options.outputMode));

    // Show pagination info if there's a next cursor
    if (result.nextCursor && options.outputMode === 'human') {
      console.log(`\nMore resource templates available. Use --cursor "${result.nextCursor}" to see more.`);
    }
  });
}

/**
 * Get a resource by URI
 */
export async function getResource(
  target: string,
  uri: string,
  options: {
    output?: string;
    raw?: boolean;
    maxSize?: number;
    outputMode: OutputMode;
    config?: string;
    headers?: string[];
    timeout?: number;
    verbose?: boolean;
  }
): Promise<void> {
  await withMcpClient(target, options, async (client) => {
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

    logTarget(target, options.outputMode);
    console.log(formatOutput(result, options.outputMode));
  });
}

/**
 * Subscribe to resource updates
 */
export async function subscribeResource(
  target: string,
  uri: string,
  options: {
    outputMode: OutputMode;
    config?: string;
    headers?: string[];
    timeout?: number;
    verbose?: boolean;
  }
): Promise<void> {
  await withMcpClient(target, options, async (client) => {
    await client.subscribeResource(uri);

    logTarget(target, options.outputMode);
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
export async function unsubscribeResource(
  target: string,
  uri: string,
  options: {
    outputMode: OutputMode;
    config?: string;
    headers?: string[];
    timeout?: number;
    verbose?: boolean;
  }
): Promise<void> {
  await withMcpClient(target, options, async (client) => {
    await client.unsubscribeResource(uri);

    logTarget(target, options.outputMode);
    if (options.outputMode === 'human') {
      console.log(formatSuccess(`Unsubscribed from resource: ${uri}`));
    } else {
      console.log(formatOutput({ unsubscribed: true, uri }, 'json'));
    }
  });
}
