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
    greenBright: (s: string) => s,
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
  greenBright: (s: string) => s,
  blue: (s: string) => s,
  magenta: (s: string) => s,
  white: (s: string) => s,
}));

// Mock sessions module before importing output
jest.mock('../../../src/lib/sessions.js', () => ({
  getSession: jest.fn().mockResolvedValue(null),
}));

// Import after mock is set up
import {
  formatSchemaType,
  formatSimplifiedArgs,
  formatToolDetail,
  formatServerDetails,
  formatResources,
  formatResourceDetail,
  formatResourceTemplates,
  formatResourceTemplateDetail,
  formatPrompts,
  formatPromptDetail,
  formatSessionLine,
  formatHuman,
  logTarget,
} from '../../../src/cli/output.js';
import type { Tool, Resource, ResourceTemplate, Prompt, ServerDetails, ServerConfig, SessionData } from '../../../src/lib/types.js';

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

describe('formatServerDetails', () => {
  it('should format server info with all features', () => {
    const details: ServerDetails = {
      protocolVersion: '2025-11-25',
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: false },
        logging: {},
        completions: {},
      },
      serverInfo: { name: 'Test Server', version: '1.2.3' },
      instructions: 'This is the server instructions.',
    };

    const output = formatServerDetails(details, '@test');

    // Should contain server info
    expect(output).toContain('Server:');
    expect(output).toContain('Test Server (version: 1.2.3)');

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
    const details: ServerDetails = {
      capabilities: {},
      serverInfo: { name: 'Minimal Server', version: '0.1.0' },
    };

    const output = formatServerDetails(details, 'https://example.com');

    // Should contain server version without protocol version
    expect(output).toContain('Server:');
    expect(output).toContain('Minimal Server (version: 0.1.0)');
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
    const details: ServerDetails = {
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: { name: 'Tools Server', version: '1.0.0' },
    };

    const output = formatServerDetails(details, '@tools');

    // Should show tools as static
    expect(output).toContain('tools (static)');

    // Should show tools commands
    expect(output).toContain('mcpc @tools tools-list');
    expect(output).toContain('mcpc @tools tools-get');
    expect(output).toContain('mcpc @tools tools-call');

    // Should NOT show other commands
    expect(output).not.toContain('resources-list');
    expect(output).not.toContain('prompts-list');
    expect(output).not.toContain('logging-set-level');
  });

  it('should format server with resources capability (subscribe only)', () => {
    const details: ServerDetails = {
      capabilities: {
        resources: { subscribe: true, listChanged: false },
      },
      serverInfo: { name: 'Resource Server', version: '2.0.0' },
    };

    const output = formatServerDetails(details, '@res');

    // Should show resources with subscribe feature
    expect(output).toContain('resources (supports subscribe)');

    // Should show resources commands
    expect(output).toContain('mcpc @res resources-list');
    expect(output).toContain('mcpc @res resources-read');
  });

  it('should format empty instructions as no Instructions section', () => {
    const details: ServerDetails = {
      capabilities: { tools: {} },
      serverInfo: { name: 'No Instructions', version: '1.0.0' },
      instructions: '   ', // whitespace-only
    };

    const output = formatServerDetails(details, '@test');

    // Should NOT contain instructions section for whitespace-only
    expect(output).not.toContain('Instructions:');
  });

  it('should format instructions with leading/trailing whitespace trimmed', () => {
    const details: ServerDetails = {
      capabilities: {},
      serverInfo: { name: 'Test', version: '1.0.0' },
      instructions: '\n\n  Some instructions here.  \n\n',
    };

    const output = formatServerDetails(details, '@test');

    // Should contain trimmed instructions
    expect(output).toContain('Instructions:');
    expect(output).toContain('Some instructions here.');
    // Should be wrapped in code block
    expect(output).toContain('````');
  });

  it('should handle server details without serverInfo', () => {
    const details: ServerDetails = {
      capabilities: { prompts: { listChanged: true } },
    };

    const output = formatServerDetails(details, '@test');

    // Should NOT contain Server: line
    expect(output).not.toMatch(/^Server:/m);

    // Should still show capabilities and commands
    expect(output).toContain('Capabilities:');
    expect(output).toContain('prompts (dynamic list)');
    expect(output).toContain('prompts-list');
    expect(output).toContain('prompts-get');
  });
});

describe('formatResources', () => {
  it('should format resource list with header and summary', () => {
    const resources: Resource[] = [
      {
        uri: 'file:///home/user/data.json',
        name: 'User Data',
        description: 'User configuration file',
        mimeType: 'application/json',
      },
      {
        uri: 'https://api.example.com/config',
        name: 'Remote Config',
      },
    ];

    const output = formatResources(resources);

    // Should have header with count
    expect(output).toContain('Available resources (2):');

    // Should have summary list
    expect(output).toContain('* `file:///home/user/data.json`');
    expect(output).toContain('* `https://api.example.com/config`');

    // Should have separators
    expect(output).toContain('---');

    // Should have detailed sections
    expect(output).toContain('Resource:');
  });

  it('should show empty list message for no resources', () => {
    const resources: Resource[] = [];
    const output = formatResources(resources);
    expect(output).toContain('Available resources (0):');
  });
});

describe('formatResourceDetail', () => {
  it('should format resource with all fields', () => {
    const resource: Resource = {
      uri: 'file:///data/config.json',
      name: 'Configuration',
      description: 'Application configuration file',
      mimeType: 'application/json',
    };

    const output = formatResourceDetail(resource);

    // Should contain URI in backticks
    expect(output).toContain('Resource:');
    expect(output).toContain('`file:///data/config.json`');

    // Should contain name
    expect(output).toContain('Name:');
    expect(output).toContain('Configuration');

    // Should contain MIME type
    expect(output).toContain('MIME type:');
    expect(output).toContain('application/json');

    // Should contain description in code block
    expect(output).toContain('Description:');
    expect(output).toContain('````');
    expect(output).toContain('Application configuration file');
  });

  it('should format resource with minimal fields', () => {
    const resource: Resource = {
      uri: 'test://minimal',
    };

    const output = formatResourceDetail(resource);

    expect(output).toContain('Resource:');
    expect(output).toContain('`test://minimal`');
    expect(output).not.toContain('Name:');
    expect(output).not.toContain('MIME type:');
    expect(output).toContain('(no description)');
  });
});

describe('formatResourceTemplates', () => {
  it('should format template list with header and summary', () => {
    const templates: ResourceTemplate[] = [
      {
        uriTemplate: 'file:///{path}',
        name: 'File Access',
        description: 'Access local files',
        mimeType: 'application/octet-stream',
      },
      {
        uriTemplate: 'https://api.example.com/{endpoint}',
        name: 'API Access',
      },
    ];

    const output = formatResourceTemplates(templates);

    // Should have header with count
    expect(output).toContain('Available resource templates (2):');

    // Should have summary list
    expect(output).toContain('* `file:///{path}`');
    expect(output).toContain('* `https://api.example.com/{endpoint}`');

    // Should have separators
    expect(output).toContain('---');

    // Should have detailed sections
    expect(output).toContain('Template:');
  });
});

describe('formatResourceTemplateDetail', () => {
  it('should format template with all fields', () => {
    const template: ResourceTemplate = {
      uriTemplate: 'test://file/{path}',
      name: 'File Template',
      description: 'Access files by path',
      mimeType: 'text/plain',
    };

    const output = formatResourceTemplateDetail(template);

    // Should contain URI template in backticks
    expect(output).toContain('Template:');
    expect(output).toContain('`test://file/{path}`');

    // Should contain name
    expect(output).toContain('Name:');
    expect(output).toContain('File Template');

    // Should contain MIME type
    expect(output).toContain('MIME type:');
    expect(output).toContain('text/plain');

    // Should contain description
    expect(output).toContain('Description:');
    expect(output).toContain('Access files by path');
  });
});

describe('formatPrompts', () => {
  it('should format prompt list with header and summary', () => {
    const prompts: Prompt[] = [
      {
        name: 'greeting',
        description: 'Generate a greeting',
        arguments: [
          { name: 'name', description: 'Name to greet', required: true },
        ],
      },
      {
        name: 'farewell',
        description: 'Generate a farewell',
      },
    ];

    const output = formatPrompts(prompts);

    // Should have header with count
    expect(output).toContain('Available prompts (2):');

    // Should have summary list
    expect(output).toContain('* `greeting`');
    expect(output).toContain('* `farewell`');

    // Should have separators
    expect(output).toContain('---');

    // Should have detailed sections
    expect(output).toContain('Prompt:');
  });
});

describe('formatPromptDetail', () => {
  it('should format prompt with arguments', () => {
    const prompt: Prompt = {
      name: 'greeting',
      description: 'Generate a personalized greeting',
      arguments: [
        { name: 'name', description: 'Name to greet', required: true },
        { name: 'style', description: 'Greeting style', required: false },
      ],
    };

    const output = formatPromptDetail(prompt);

    // Should contain prompt name
    expect(output).toContain('Prompt:');
    expect(output).toContain('`greeting`');

    // Should contain arguments section
    expect(output).toContain('Arguments:');
    expect(output).toContain('`name`');
    expect(output).toContain('string');
    expect(output).toContain('[required]');
    expect(output).toContain('Name to greet');

    expect(output).toContain('`style`');
    expect(output).not.toMatch(/`style`.*\[required\]/);

    // Should contain description
    expect(output).toContain('Description:');
    expect(output).toContain('Generate a personalized greeting');
  });

  it('should format prompt with no arguments', () => {
    const prompt: Prompt = {
      name: 'simple',
      description: 'A simple prompt',
    };

    const output = formatPromptDetail(prompt);

    expect(output).toContain('Prompt:');
    expect(output).toContain('`simple`');
    expect(output).toContain('Arguments:');
    expect(output).toContain('(no arguments)');
    expect(output).toContain('Description:');
    expect(output).toContain('A simple prompt');
  });

  it('should format prompt with no description', () => {
    const prompt: Prompt = {
      name: 'undocumented',
    };

    const output = formatPromptDetail(prompt);

    expect(output).toContain('Prompt:');
    expect(output).toContain('`undocumented`');
    expect(output).toContain('Description:');
    expect(output).toContain('(no description)');
  });

  it('should format prompt argument with required indicator in correct style', () => {
    const prompt: Prompt = {
      name: 'test',
      arguments: [
        { name: 'required_arg', required: true },
        { name: 'optional_arg', required: false },
      ],
    };

    const output = formatPromptDetail(prompt);

    // Required should show [required] in same format as tools
    expect(output).toContain('`required_arg`: string [required]');
    // Optional should NOT have [required]
    expect(output).toContain('`optional_arg`: string');
    expect(output).not.toMatch(/`optional_arg`.*\[required\]/);
  });
});

describe('formatHuman with GetPromptResult', () => {
  it('should format single text message with backticks', () => {
    const result = {
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: 'Hello, world!' },
        },
      ],
    };

    const output = formatHuman(result);

    expect(output).toContain('Messages (1):');
    expect(output).toContain('Role: user');
    expect(output).toContain('````');
    expect(output).toContain('Hello, world!');
  });

  it('should format multiple messages', () => {
    const result = {
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: 'First message' },
        },
        {
          role: 'assistant',
          content: { type: 'text', text: 'Second message' },
        },
      ],
    };

    const output = formatHuman(result);

    expect(output).toContain('Messages (2):');
    expect(output).toContain('Role: user');
    expect(output).toContain('First message');
    expect(output).toContain('Role: assistant');
    expect(output).toContain('Second message');
  });

  it('should format image content', () => {
    const result = {
      messages: [
        {
          role: 'user',
          content: { type: 'image', data: 'base64data...', mimeType: 'image/png' },
        },
      ],
    };

    const output = formatHuman(result);

    expect(output).toContain('Messages (1):');
    expect(output).toContain('[Image: image/png]');
  });

  it('should format audio content', () => {
    const result = {
      messages: [
        {
          role: 'user',
          content: { type: 'audio', data: 'audiodata', mimeType: 'audio/mp3' },
        },
      ],
    };

    const output = formatHuman(result);

    expect(output).toContain('[Audio: audio/mp3]');
  });

  it('should format resource_link content', () => {
    const result = {
      messages: [
        {
          role: 'user',
          content: { type: 'resource_link', uri: 'file:///path/to/file.txt' },
        },
      ],
    };

    const output = formatHuman(result);

    expect(output).toContain('[Resource link: file:///path/to/file.txt]');
  });

  it('should format embedded resource content', () => {
    const result = {
      messages: [
        {
          role: 'user',
          content: {
            type: 'resource',
            resource: { uri: 'file:///data.json', text: 'embedded content' },
          },
        },
      ],
    };

    const output = formatHuman(result);

    expect(output).toContain('[Embedded resource: file:///data.json]');
    expect(output).toContain('embedded content');
  });

  it('should include description before messages', () => {
    const result = {
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: 'Message text' },
        },
      ],
      description: 'This is a prompt description',
    };

    const output = formatHuman(result);

    expect(output).toContain('Description:');
    expect(output).toContain('This is a prompt description');
    // Description should come before Messages
    const descIndex = output.indexOf('Description:');
    const messagesIndex = output.indexOf('Messages (1):');
    expect(descIndex).toBeLessThan(messagesIndex);
  });

  it('should handle unknown content types gracefully', () => {
    const result = {
      messages: [
        {
          role: 'user',
          content: { type: 'unknown_type', data: 'some data' },
        },
      ],
    };

    const output = formatHuman(result);

    // Should fall back to JSON representation
    expect(output).toContain('Messages (1):');
    expect(output).toContain('unknown_type');
  });

  it('should NOT treat empty messages array as prompt result', () => {
    const result = {
      messages: [],
    };

    const output = formatHuman(result);

    // Should NOT show "Messages (0):" header since empty messages
    // falls back to generic object formatting
    expect(output).not.toContain('Messages (0):');
  });

  it('should NOT treat objects without role/content as prompt result', () => {
    const result = {
      messages: [
        { id: 1, text: 'not a prompt message' },
      ],
    };

    const output = formatHuman(result);

    // Should NOT show "Messages (1):" header
    expect(output).not.toContain('Messages (1):');
  });
});

describe('formatSessionLine', () => {
  it('should format HTTP session with all fields', () => {
    const session: SessionData = {
      name: '@test',
      server: { url: 'https://mcp.example.com' },
      profileName: 'default',
      protocolVersion: '2025-11-25',
      createdAt: '2025-01-01T00:00:00Z',
    };

    const output = formatSessionLine(session);

    expect(output).toContain('@test');
    expect(output).toContain('https://mcp.example.com');
    expect(output).toContain('HTTP');
    expect(output).toContain('OAuth');
    expect(output).toContain('default');
    expect(output).toContain('MCP: 2025-11-25');
  });

  it('should format stdio session', () => {
    const session: SessionData = {
      name: '@fs',
      server: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      },
      createdAt: '2025-01-01T00:00:00Z',
    };

    const output = formatSessionLine(session);

    expect(output).toContain('@fs');
    expect(output).toContain('npx');
    expect(output).toContain('stdio');
  });

  it('should include proxy info when configured', () => {
    const session: SessionData = {
      name: '@proxy-test',
      server: { url: 'https://mcp.example.com' },
      proxy: { host: '127.0.0.1', port: 8080 },
      createdAt: '2025-01-01T00:00:00Z',
    };

    const output = formatSessionLine(session);

    expect(output).toContain('@proxy-test');
    expect(output).toContain('[proxy:');
    expect(output).toContain('127.0.0.1:8080');
  });

  it('should include proxy with custom host', () => {
    const session: SessionData = {
      name: '@proxy-custom',
      server: { url: 'https://mcp.example.com' },
      proxy: { host: '0.0.0.0', port: 3000 },
      createdAt: '2025-01-01T00:00:00Z',
    };

    const output = formatSessionLine(session);

    expect(output).toContain('0.0.0.0:3000');
  });

  it('should not include proxy info when not configured', () => {
    const session: SessionData = {
      name: '@simple',
      server: { url: 'https://mcp.example.com' },
      createdAt: '2025-01-01T00:00:00Z',
    };

    const output = formatSessionLine(session);

    expect(output).not.toContain('[proxy:');
  });
});

describe('logTarget', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should not leak serverConfig.headers in output', async () => {
    const serverConfig: ServerConfig = {
      url: 'https://mcp.example.com',
      headers: {
        'Authorization': 'Bearer super-secret-token-12345',
        'X-Api-Key': 'secret-api-key-67890',
      },
    };

    await logTarget('https://mcp.example.com', {
      outputMode: 'human',
      serverConfig,
    });

    // Get the output that was logged
    const output = consoleSpy.mock.calls.map(call => call.join(' ')).join('\n');

    // Should NOT contain any header values
    expect(output).not.toContain('super-secret-token-12345');
    expect(output).not.toContain('secret-api-key-67890');
    expect(output).not.toContain('Bearer');

    // Should still show the server URL
    expect(output).toContain('https://mcp.example.com');
  });

  it('should not leak headers for stdio transport', async () => {
    const serverConfig: ServerConfig = {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-test'],
      headers: {
        'Authorization': 'Bearer leaked-token',
      },
    };

    await logTarget('test-server', {
      outputMode: 'human',
      serverConfig,
    });

    const output = consoleSpy.mock.calls.map(call => call.join(' ')).join('\n');

    // Should NOT contain header values
    expect(output).not.toContain('leaked-token');
    expect(output).not.toContain('Authorization');

    // Should show command info
    expect(output).toContain('npx');
    expect(output).toContain('stdio');
  });

  it('should not output anything in json mode', async () => {
    const serverConfig: ServerConfig = {
      url: 'https://mcp.example.com',
      headers: {
        'Authorization': 'Bearer secret',
      },
    };

    await logTarget('https://mcp.example.com', {
      outputMode: 'json',
      serverConfig,
    });

    // Should not log anything in json mode
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});
