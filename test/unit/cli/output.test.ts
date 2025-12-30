/**
 * Tests for CLI output formatting
 */

import { extractSingleTextContent } from '../../../src/cli/tool-result.js';

// Mock chalk to return plain strings (required because Jest can't handle chalk's ESM imports)
jest.mock('chalk', () => ({
  default: {
    cyan: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
    dim: (s: string) => s,
    gray: (s: string) => s,
    bold: (s: string) => s,
    green: (s: string) => s,
    blue: (s: string) => s,
    magenta: (s: string) => s,
    white: (s: string) => s,
  },
  cyan: (s: string) => s,
  yellow: (s: string) => s,
  red: (s: string) => s,
  dim: (s: string) => s,
  gray: (s: string) => s,
  bold: (s: string) => s,
  green: (s: string) => s,
  blue: (s: string) => s,
  magenta: (s: string) => s,
  white: (s: string) => s,
}));

// Import after mock is set up
import { formatSchemaType, formatSimplifiedArgs, formatToolDetail, formatServerInfo } from '../../../src/cli/output.js';
import type { Tool, ServerInfo } from '../../../src/lib/types.js';

describe('extractSingleTextContent', () => {
  it('should return text for single text content item', () => {
    const result = {
      content: [{ type: 'text', text: 'Hello world' }],
    };
    expect(extractSingleTextContent(result)).toBe('Hello world');
  });

  it('should return text even if structuredContent is present', () => {
    const result = {
      content: [{ type: 'text', text: 'Some markdown' }],
      structuredContent: { foo: 'bar' },
    };
    expect(extractSingleTextContent(result)).toBe('Some markdown');
  });

  it('should return undefined for multiple content items', () => {
    const result = {
      content: [
        { type: 'text', text: 'First' },
        { type: 'text', text: 'Second' },
      ],
    };
    expect(extractSingleTextContent(result)).toBeUndefined();
  });

  it('should return undefined for non-text content type', () => {
    const result = {
      content: [{ type: 'image', data: 'base64...' }],
    };
    expect(extractSingleTextContent(result)).toBeUndefined();
  });

  it('should return undefined for empty content array', () => {
    const result = {
      content: [],
    };
    expect(extractSingleTextContent(result)).toBeUndefined();
  });

  it('should return undefined for missing content field', () => {
    const result = {
      structuredContent: { foo: 'bar' },
    };
    expect(extractSingleTextContent(result)).toBeUndefined();
  });

  it('should return undefined for null', () => {
    expect(extractSingleTextContent(null)).toBeUndefined();
  });

  it('should return undefined for undefined', () => {
    expect(extractSingleTextContent(undefined)).toBeUndefined();
  });

  it('should return undefined for non-object', () => {
    expect(extractSingleTextContent('string')).toBeUndefined();
    expect(extractSingleTextContent(123)).toBeUndefined();
    expect(extractSingleTextContent(true)).toBeUndefined();
  });

  it('should return undefined if text field is not a string', () => {
    const result = {
      content: [{ type: 'text', text: 123 }],
    };
    expect(extractSingleTextContent(result)).toBeUndefined();
  });

  it('should handle empty string text', () => {
    const result = {
      content: [{ type: 'text', text: '' }],
    };
    expect(extractSingleTextContent(result)).toBe('');
  });
});

describe('formatSchemaType', () => {
  it('should return simple type string', () => {
    expect(formatSchemaType({ type: 'string' })).toBe('string');
    expect(formatSchemaType({ type: 'number' })).toBe('number');
    expect(formatSchemaType({ type: 'boolean' })).toBe('boolean');
    expect(formatSchemaType({ type: 'integer' })).toBe('integer');
    expect(formatSchemaType({ type: 'object' })).toBe('object');
  });

  it('should handle union types (array of types)', () => {
    expect(formatSchemaType({ type: ['string', 'null'] })).toBe('string | null');
    expect(formatSchemaType({ type: ['number', 'string', 'boolean'] })).toBe(
      'number | string | boolean'
    );
  });

  it('should handle array type with items', () => {
    expect(formatSchemaType({ type: 'array', items: { type: 'string' } })).toBe('array<string>');
    expect(formatSchemaType({ type: 'array', items: { type: 'number' } })).toBe('array<number>');
    expect(
      formatSchemaType({
        type: 'array',
        items: { type: 'array', items: { type: 'boolean' } },
      })
    ).toBe('array<array<boolean>>');
  });

  it('should handle object type with properties', () => {
    expect(
      formatSchemaType({
        type: 'object',
        properties: { name: { type: 'string' } },
      })
    ).toBe('object');
  });

  it('should handle small enums (5 or fewer values)', () => {
    expect(formatSchemaType({ enum: ['a', 'b', 'c'] })).toBe('"a" | "b" | "c"');
    expect(formatSchemaType({ enum: [1, 2, 3] })).toBe('1 | 2 | 3');
    expect(formatSchemaType({ enum: [true, false] })).toBe('true | false');
  });

  it('should handle large enums (more than 5 values)', () => {
    expect(formatSchemaType({ enum: ['a', 'b', 'c', 'd', 'e', 'f'] })).toBe('enum(6 values)');
    expect(formatSchemaType({ enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })).toBe('enum(10 values)');
  });

  it('should handle oneOf', () => {
    expect(formatSchemaType({ oneOf: [{ type: 'string' }, { type: 'number' }] })).toBe(
      'string | number'
    );
  });

  it('should handle anyOf', () => {
    expect(formatSchemaType({ anyOf: [{ type: 'boolean' }, { type: 'null' }] })).toBe(
      'boolean | null'
    );
  });

  it('should return "any" for invalid input', () => {
    expect(formatSchemaType(null as unknown as Record<string, unknown>)).toBe('any');
    expect(formatSchemaType(undefined as unknown as Record<string, unknown>)).toBe('any');
    expect(formatSchemaType('string' as unknown as Record<string, unknown>)).toBe('any');
    expect(formatSchemaType({} as Record<string, unknown>)).toBe('any');
  });
});

describe('formatSimplifiedArgs', () => {
  it('should format simple properties with bullet points', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
    };
    const lines = formatSimplifiedArgs(schema);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('* `name`: string');
    expect(lines[1]).toBe('* `age`: number');
  });

  it('should mark required properties', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
      },
      required: ['name'],
    };
    const lines = formatSimplifiedArgs(schema);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('* `name`: string [required]');
    expect(lines[1]).toBe('* `email`: string');
  });

  it('should include descriptions', () => {
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file path to read' },
      },
    };
    const lines = formatSimplifiedArgs(schema);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('* `path`: string - The file path to read');
  });

  it('should include default values', () => {
    const schema = {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 10 },
        enabled: { type: 'boolean', default: true },
        format: { type: 'string', default: 'json' },
      },
    };
    const lines = formatSimplifiedArgs(schema);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('* `limit`: number (default: 10)');
    expect(lines[1]).toBe('* `enabled`: boolean (default: true)');
    expect(lines[2]).toBe('* `format`: string (default: "json")');
  });

  it('should handle full combination of required, description, and default', () => {
    const schema = {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
        limit: {
          type: 'number',
          description: 'Max results',
          default: 10,
        },
      },
      required: ['query'],
    };
    const lines = formatSimplifiedArgs(schema);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('* `query`: string [required] - Search query');
    expect(lines[1]).toBe('* `limit`: number (default: 10) - Max results');
  });

  it('should use custom indent', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
    };
    const lines = formatSimplifiedArgs(schema, '  ');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('  * `name`: string');
  });

  it('should return "(none)" for schema without properties', () => {
    const lines1 = formatSimplifiedArgs({ type: 'object' });
    expect(lines1).toEqual(['* (none)']);

    const lines2 = formatSimplifiedArgs({ type: 'object', properties: {} });
    expect(lines2).toEqual(['* (none)']);
  });

  it('should return "(none)" for null or invalid schema', () => {
    expect(formatSimplifiedArgs(null as unknown as Record<string, unknown>)).toEqual([
      '* (none)',
    ]);
    expect(formatSimplifiedArgs(undefined as unknown as Record<string, unknown>)).toEqual([
      '* (none)',
    ]);
    expect(formatSimplifiedArgs('string' as unknown as Record<string, unknown>)).toEqual([
      '* (none)',
    ]);
  });

  it('should handle complex types in properties', () => {
    const schema = {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
        status: { enum: ['active', 'inactive'] },
        data: { type: ['string', 'null'] },
      },
    };
    const lines = formatSimplifiedArgs(schema);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('* `tags`: array<string>');
    expect(lines[1]).toBe('* `status`: "active" | "inactive"');
    expect(lines[2]).toBe('* `data`: string | null');
  });
});

describe('formatToolDetail', () => {
  it('should format tool with all features: title, annotations, input, output, description', () => {
    const tool: Tool = {
      name: 'call-actor',
      description: 'Calls an Actor on Apify platform',
      inputSchema: {
        type: 'object',
        properties: {
          actorId: { type: 'string', description: 'Actor ID to call' },
          input: { type: 'object', description: 'Input for the Actor' },
        },
        required: ['actorId'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: 'ID of the Actor run' },
        },
      },
      annotations: {
        title: 'Call Actor',
        openWorldHint: true,
      },
    };

    const output = formatToolDetail(tool);

    // Should contain title as heading
    expect(output).toContain('# Call Actor');

    // Should contain tool name with annotations
    expect(output).toContain('Tool:');
    expect(output).toContain('`call-actor`');
    expect(output).toContain('[open-world]');

    // Should contain Input section with arguments
    expect(output).toContain('Input:');
    expect(output).toContain('`actorId`');
    expect(output).toContain('[required]');
    expect(output).toContain('Actor ID to call');
    expect(output).toContain('`input`');

    // Should contain Output section
    expect(output).toContain('Output:');
    expect(output).toContain('`runId`');
    expect(output).toContain('ID of the Actor run');

    // Should contain Description in code block
    expect(output).toContain('Description:');
    expect(output).toContain('````');
    expect(output).toContain('Calls an Actor on Apify platform');
  });

  it('should format tool with minimal features (no title, no output, no annotations)', () => {
    const tool: Tool = {
      name: 'simple-tool',
      description: 'A simple tool',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
      },
    };

    const output = formatToolDetail(tool);

    // Should NOT contain title heading (no annotations.title)
    expect(output).not.toContain('# ');

    // Should contain tool name
    expect(output).toContain('Tool:');
    expect(output).toContain('`simple-tool`');

    // Should NOT contain annotation brackets (no annotations)
    expect(output).not.toContain('[read-only]');
    expect(output).not.toContain('[open-world]');

    // Should contain Input section
    expect(output).toContain('Input:');
    expect(output).toContain('`query`');

    // Should NOT contain Output section
    expect(output).not.toMatch(/Output:/);

    // Should contain Description
    expect(output).toContain('Description:');
    expect(output).toContain('A simple tool');
  });

  it('should format tool with read-only annotation', () => {
    const tool: Tool = {
      name: 'fetch-data',
      description: 'Fetches data',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      annotations: {
        readOnlyHint: true,
      },
    };

    const output = formatToolDetail(tool);

    expect(output).toContain('[read-only]');
    expect(output).not.toContain('[open-world]');
  });

  it('should show (none) for tool with no input properties', () => {
    const tool: Tool = {
      name: 'no-args-tool',
      description: 'Tool with no arguments',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    };

    const output = formatToolDetail(tool);

    expect(output).toContain('Input:');
    expect(output).toContain('(none)');
  });

  it('should show (no description) placeholder when description is missing', () => {
    const tool: Tool = {
      name: 'undocumented-tool',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    };

    const output = formatToolDetail(tool);

    expect(output).toContain('Description:');
    expect(output).toContain('(no description)');
  });

  it('should show default values for input arguments', () => {
    const tool: Tool = {
      name: 'tool-with-defaults',
      description: 'Tool with default values',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 100, description: 'Max items' },
          format: { type: 'string', default: 'json' },
        },
      },
    };

    const output = formatToolDetail(tool);

    expect(output).toContain('(default: 100)');
    expect(output).toContain('(default: "json")');
    // Default should come before description
    expect(output).toMatch(/\(default: 100\).*Max items/);
  });
});

describe('formatServerInfo', () => {
  it('should format server info with all features', () => {
    const info: ServerInfo = {
      serverVersion: { name: 'Test Server', version: '1.2.3' },
      protocolVersion: '2025-11-25',
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: false },
        logging: {},
        completions: {},
      },
      instructions: 'This is the server instructions.',
    };

    const output = formatServerInfo(info, '@test');

    // Should contain server version and protocol version
    expect(output).toContain('Server:');
    expect(output).toContain('Test Server v1.2.3');
    expect(output).toContain('(MCP version: 2025-11-25)');

    // Should contain capabilities section
    expect(output).toContain('Capabilities:');
    expect(output).toContain('tools (dynamic)');
    expect(output).toContain('resources (supports subscribe, dynamic list)');
    expect(output).toContain('prompts');
    expect(output).toContain('logging');
    expect(output).toContain('completions');

    // Should contain available commands
    expect(output).toContain('Available commands:');
    expect(output).toContain('mcpc @test tools-list');
    expect(output).toContain('mcpc @test tools-call');
    expect(output).toContain('mcpc @test resources-list');
    expect(output).toContain('mcpc @test resources-read');
    expect(output).toContain('mcpc @test prompts-list');
    expect(output).toContain('mcpc @test logging-set-level');
    expect(output).toContain('mcpc @test shell');

    // Should contain instructions in code block
    expect(output).toContain('Instructions:');
    expect(output).toContain('````');
    expect(output).toContain('This is the server instructions.');
  });

  it('should format server info with minimal features', () => {
    const info: ServerInfo = {
      serverVersion: { name: 'Minimal Server', version: '0.1.0' },
      capabilities: {},
    };

    const output = formatServerInfo(info, 'https://example.com');

    // Should contain server version without protocol version
    expect(output).toContain('Server:');
    expect(output).toContain('Minimal Server v0.1.0');
    expect(output).not.toContain('MCP version');

    // Should show (none) for capabilities
    expect(output).toContain('Capabilities:');
    expect(output).toContain('(none)');

    // Should only show shell command
    expect(output).toContain('Available commands:');
    expect(output).toContain('mcpc https://example.com shell');
    expect(output).not.toContain('tools-list');
    expect(output).not.toContain('resources-list');
    expect(output).not.toContain('prompts-list');

    // Should NOT contain instructions section (no instructions provided)
    expect(output).not.toContain('Instructions:');
  });

  it('should format server with only tools capability', () => {
    const info: ServerInfo = {
      serverVersion: { name: 'Tools Server', version: '1.0.0' },
      capabilities: {
        tools: { listChanged: false },
      },
    };

    const output = formatServerInfo(info, '@tools');

    // Should show tools as static
    expect(output).toContain('tools (static)');

    // Should show tools commands
    expect(output).toContain('mcpc @tools tools-list');
    expect(output).toContain('mcpc @tools tools-schema');
    expect(output).toContain('mcpc @tools tools-call');

    // Should NOT show other commands
    expect(output).not.toContain('resources-list');
    expect(output).not.toContain('prompts-list');
    expect(output).not.toContain('logging-set-level');
  });

  it('should format server with resources capability (subscribe only)', () => {
    const info: ServerInfo = {
      serverVersion: { name: 'Resource Server', version: '2.0.0' },
      capabilities: {
        resources: { subscribe: true, listChanged: false },
      },
    };

    const output = formatServerInfo(info, '@res');

    // Should show resources with subscribe feature
    expect(output).toContain('resources (supports subscribe)');

    // Should show resources commands
    expect(output).toContain('mcpc @res resources-list');
    expect(output).toContain('mcpc @res resources-read');
  });

  it('should format empty instructions as no Instructions section', () => {
    const info: ServerInfo = {
      serverVersion: { name: 'No Instructions', version: '1.0.0' },
      capabilities: { tools: {} },
      instructions: '   ',  // whitespace-only
    };

    const output = formatServerInfo(info, '@test');

    // Should NOT contain instructions section for whitespace-only
    expect(output).not.toContain('Instructions:');
  });

  it('should format instructions with leading/trailing whitespace trimmed', () => {
    const info: ServerInfo = {
      serverVersion: { name: 'Test', version: '1.0.0' },
      capabilities: {},
      instructions: '\n\n  Some instructions here.  \n\n',
    };

    const output = formatServerInfo(info, '@test');

    // Should contain trimmed instructions
    expect(output).toContain('Instructions:');
    expect(output).toContain('Some instructions here.');
    // Should be wrapped in code block
    expect(output).toContain('````');
  });

  it('should handle server info without serverVersion', () => {
    const info: ServerInfo = {
      capabilities: { prompts: { listChanged: true } },
    };

    const output = formatServerInfo(info, '@test');

    // Should NOT contain Server: line
    expect(output).not.toMatch(/^Server:/m);

    // Should still show capabilities and commands
    expect(output).toContain('Capabilities:');
    expect(output).toContain('prompts (dynamic list)');
    expect(output).toContain('prompts-list');
    expect(output).toContain('prompts-get');
  });
});
