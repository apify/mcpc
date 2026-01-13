/**
 * Code generation module for MCP servers
 *
 * Generates typed client stubs for MCP servers in various languages.
 */

export { generateTypeScriptProject } from './typescript/index.js';
export type { McpServerData, GeneratedFile } from './typescript/index.js';
export { jsonSchemaToTs, toPascalCase, toCamelCase, deduplicateNames } from './typescript/json-schema-to-ts.js';
export type { JsonSchema } from './typescript/json-schema-to-ts.js';
