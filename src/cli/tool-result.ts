/**
 * Utility functions for handling MCP tool results
 */

/**
 * Check if the data is a tool call result with a single text content item (`content: [ type: 'text', 'text': ... }]`)
 * If so, return the text content; otherwise return undefined
 */
export function extractSingleTextContent(data: unknown): string | undefined {
  if (
    data &&
    typeof data === 'object' &&
    'content' in data &&
    Array.isArray((data as Record<string, unknown>).content)
  ) {
    const content = (data as Record<string, unknown>).content as unknown[];
    if (
      content.length === 1 &&
      content[0] &&
      typeof content[0] === 'object' &&
      'type' in content[0] &&
      (content[0] as Record<string, unknown>).type === 'text' &&
      'text' in content[0] &&
      typeof (content[0] as Record<string, unknown>).text === 'string'
    ) {
      return (content[0] as Record<string, unknown>).text as string;
    }
  }
  return undefined;
}
