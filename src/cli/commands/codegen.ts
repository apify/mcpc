/**
 * Codegen command handler
 *
 * Generates typed client stubs for MCP servers.
 */

import { mkdir, writeFile, access } from 'fs/promises';
import { join, resolve } from 'path';
import { formatSuccess, formatInfo } from '../output.js';
import { ClientError } from '../../lib/errors.js';
import type { CommandOptions } from '../../lib/types.js';
import { withMcpClient } from '../helpers.js';
import { generateTypeScriptProject, McpServerData } from '../../lib/codegen/index.js';

export interface CodegenOptions extends CommandOptions {
  language?: string;
  force?: boolean;
}

/**
 * Generate typed client stubs for an MCP server.
 */
export async function codegen(
  target: string,
  outputDir: string,
  options: CodegenOptions,
): Promise<void> {
  const language = (options.language || 'ts').toLowerCase();

  // Validate language (accept 'ts' or 'typescript', case-insensitive)
  if (language !== 'ts' && language !== 'typescript') {
    throw new ClientError(`Unsupported language: ${options.language}. Currently only 'ts' or 'typescript' is supported.`);
  }

  // Resolve output directory
  const targetDir = resolve(outputDir);

  // Check if directory exists (unless --force)
  if (!options.force) {
    try {
      await access(targetDir);
      throw new ClientError(
        `Directory already exists: ${targetDir}\n` +
        `Use --force to overwrite existing files.`,
      );
    } catch (err) {
      // Directory doesn't exist - that's good
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  await withMcpClient(target, options, async (client, _context) => {
    // Fetch server capabilities
    const serverDetails = await client.getServerDetails();
    const capabilities = serverDetails.capabilities;

    console.log(formatInfo(`Fetching server data from ${serverDetails.serverInfo?.name || target}...`));

    // Fetch tools (if supported)
    const tools = [];
    if (capabilities?.tools) {
      let cursor: string | undefined = undefined;
      do {
        const result = await client.listTools(cursor);
        tools.push(...result.tools);
        cursor = result.nextCursor;
      } while (cursor);
      console.log(formatInfo(`  Found ${tools.length} tool(s)`));
    }

    // Fetch prompts (if supported)
    const prompts = [];
    if (capabilities?.prompts) {
      let cursor: string | undefined = undefined;
      do {
        const result = await client.listPrompts(cursor);
        prompts.push(...result.prompts);
        cursor = result.nextCursor;
      } while (cursor);
      console.log(formatInfo(`  Found ${prompts.length} prompt(s)`));
    }

    // Fetch resources (if supported)
    const resources = [];
    if (capabilities?.resources) {
      let cursor: string | undefined = undefined;
      do {
        const result = await client.listResources(cursor);
        resources.push(...result.resources);
        cursor = result.nextCursor;
      } while (cursor);
      console.log(formatInfo(`  Found ${resources.length} resource(s)`));
    }

    // Prepare server data
    const serverName = serverDetails.serverInfo?.name || 'mcp-server';
    const serverData: McpServerData = {
      serverName,
      tools,
      prompts,
      resources,
      hasLogging: !!capabilities?.logging,
    };
    if (serverDetails.serverInfo?.version) {
      serverData.serverVersion = serverDetails.serverInfo.version;
    }

    // Generate files
    console.log(formatInfo('Generating TypeScript project...'));
    const files = generateTypeScriptProject(serverData);

    // Write files
    for (const file of files) {
      const filePath = join(targetDir, file.path);
      const dir = join(filePath, '..');

      // Create directory if needed
      await mkdir(dir, { recursive: true });

      // Write file
      await writeFile(filePath, file.content, 'utf-8');
      console.log(formatInfo(`  Created ${file.path}`));
    }

    console.log('');
    console.log(formatSuccess(`Generated TypeScript project in ${targetDir}`));
    console.log('');
    console.log('Next steps:');
    console.log(`  cd ${outputDir}`);
    console.log('  npm install');
    console.log('  npm run build');
    console.log('');
    console.log('Usage:');
    console.log("  import { McpcClient, createTools } from './dist';");
    console.log('');
    console.log(`  const client = new McpcClient({ target: '${target}' });`);
    const firstTool = tools[0];
    if (firstTool) {
      console.log('  const tools = createTools(client);');
      console.log(`  const result = await tools.${toCamelCase(firstTool.name)}({ /* args */ });`);
    }
  });
}

/**
 * Convert a string to camelCase.
 */
function toCamelCase(str: string): string {
  return str
    .replace(/[-_](.)/g, (_, c) => c.toUpperCase())
    .replace(/^(.)/, (_, c) => c.toLowerCase());
}
