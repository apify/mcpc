/**
 * Resources command handlers
 */

import type { OutputMode } from '../../lib/types.js';
import { formatOutput, formatSuccess, logTarget } from '../output.js';

/**
 * List available resources
 */
export async function listResources(
  target: string,
  options: {
    cursor?: string;
    outputMode: OutputMode;
  }
): Promise<void> {
  // TODO: Connect to MCP client using target and list resources

  const mockResources = [
    {
      uri: 'file:///documents/report.pdf',
      name: 'Annual Report',
      mimeType: 'application/pdf',
      description: '2024 annual report',
    },
    {
      uri: 'https://api.example.com/data',
      name: 'API Data',
      mimeType: 'application/json',
      description: 'Live data from API',
    },
  ];

  logTarget(target, options.outputMode);
  console.log(formatOutput(mockResources, options.outputMode));
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
  }
): Promise<void> {
  // TODO: Connect to MCP client using target and get resource

  const mockResource = {
    uri,
    contents: [
      {
        uri,
        mimeType: 'text/plain',
        text: `Content of resource: ${uri}`,
      },
    ],
  };

  logTarget(target, options.outputMode);
  console.log(formatOutput(mockResource, options.outputMode));
}

/**
 * Subscribe to resource updates
 */
export async function subscribeResource(
  target: string,
  uri: string,
  options: { outputMode: OutputMode }
): Promise<void> {
  // TODO: Connect to MCP client using target and subscribe

  logTarget(target, options.outputMode);
  if (options.outputMode === 'human') {
    console.log(formatSuccess(`Subscribed to resource: ${uri}`));
  } else {
    console.log(formatOutput({ subscribed: true, uri }, 'json'));
  }
}

/**
 * Unsubscribe from resource updates
 */
export async function unsubscribeResource(
  target: string,
  uri: string,
  options: { outputMode: OutputMode }
): Promise<void> {
  // TODO: Connect to MCP client using target and unsubscribe

  logTarget(target, options.outputMode);
  if (options.outputMode === 'human') {
    console.log(formatSuccess(`Unsubscribed from resource: ${uri}`));
  } else {
    console.log(formatOutput({ unsubscribed: true, uri }, 'json'));
  }
}
