/**
 * Tests for CLI output formatting
 */

import type { MockInstance } from 'vitest';
import { extractAllTextContent } from '../../../src/cli/tool-result.js';

// Mock chalk to return plain strings (required because Jest can't handle chalk's ESM imports)
vi.mock('chalk', () => {
  const identity = (s: string): string => s;
  const hex = (): ((s: string) => string) => identity;
  const palette = {
    cyan: identity,
    yellow: identity,
    red: identity,
    dim: identity,
    gray: identity,
    bold: identity,
    green: identity,
    greenBright: identity,
    blue: identity,
    magenta: identity,
    white: identity,
    hex,
  };
  return { default: palette, ...palette };
});

// Mock sessions module before importing output
vi.mock('../../../src/lib/sessions.js', () => ({
  getSession: vi.fn().mockResolvedValue(null),
}));

// Import after mock is set up
import {
  formatSchemaType,
  shortType,
  formatToolParamsInline,
  formatSimplifiedArgs,
  formatTools,
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
  formatToolCallExample,
  formatToolHints,
  formatCallToolResultHuman,
} from '../../../src/cli/output.js';
import type {
  Tool,
  Resource,
  ResourceTemplate,
  Prompt,
  ServerDetails,
  SessionData,
} from '../../../src/lib/types.js';

describe('extractAllTextContent', () => {
  it('should return text for single text content item', () => {
    const result = {
      content: [{ type: 'text', text: 'Hello world' }],
    };
    expect(extractAllTextContent(result)).toBe('Hello world');
  });

  it('should return text even if structuredContent is present', () => {
    const result = {
      content: [{ type: 'text', text: 'Some markdown' }],
      structuredContent: { foo: 'bar' },
    };
    expect(extractAllTextContent(result)).toBe('Some markdown');
  });

  it('should join texts when content is multiple text items', () => {
    const result = {
      content: [
        { type: 'text', text: 'First' },
        { type: 'text', text: 'Second' },
      ],
    };
    expect(extractAllTextContent(result)).toBe('First\nSecond');
  });

  it('should return undefined when content mixes text and non-text items', () => {
    const result = {
      content: [
        { type: 'text', text: 'First' },
        { type: 'image', data: 'base64...' },
      ],
    };
    expect(extractAllTextContent(result)).toBeUndefined();
  });

  it('should return undefined for non-text content type', () => {
    const result = {
      content: [{ type: 'image', data: 'base64...' }],
    };
    expect(extractAllTextContent(result)).toBeUndefined();
  });

  it('should return undefined for empty content array', () => {
    const result = {
      content: [],
    };
    expect(extractAllTextContent(result)).toBeUndefined();
  });

  it('should return undefined for missing content field', () => {
    const result = {
      structuredContent: { foo: 'bar' },
    };
    expect(extractAllTextContent(result)).toBeUndefined();
  });

  it('should return undefined for null', () => {
    expect(extractAllTextContent(null)).toBeUndefined();
  });

  it('should return undefined for undefined', () => {
    expect(extractAllTextContent(undefined)).toBeUndefined();
  });

  it('should return undefined for non-object', () => {
    expect(extractAllTextContent('string')).toBeUndefined();
    expect(extractAllTextContent(123)).toBeUndefined();
    expect(extractAllTextContent(true)).toBeUndefined();
  });

  it('should return undefined if text field is not a string', () => {
    const result = {
      content: [{ type: 'text', text: 123 }],
    };
    expect(extractAllTextContent(result)).toBeUndefined();
  });

  it('should handle empty string text', () => {
    const result = {
      content: [{ type: 'text', text: '' }],
    };
    expect(extractAllTextContent(result)).toBe('');
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

describe('shortType', () => {
  it('should abbreviate primitive types', () => {
    expect(shortType({ type: 'string' })).toBe('str');
    expect(shortType({ type: 'number' })).toBe('num');
    expect(shortType({ type: 'integer' })).toBe('int');
    expect(shortType({ type: 'boolean' })).toBe('bool');
    expect(shortType({ type: 'object' })).toBe('obj');
  });

  it('should format array types with brackets', () => {
    expect(shortType({ type: 'array', items: { type: 'string' } })).toBe('[str]');
    expect(shortType({ type: 'array', items: { type: 'number' } })).toBe('[num]');
    expect(shortType({ type: 'array', items: { type: 'object' } })).toBe('[obj]');
    expect(shortType({ type: 'array' })).toBe('[any]');
  });

  it('should handle nested arrays', () => {
    expect(shortType({ type: 'array', items: { type: 'array', items: { type: 'boolean' } } })).toBe(
      '[[bool]]'
    );
  });

  it('should handle union types, filtering null', () => {
    expect(shortType({ type: ['string', 'null'] })).toBe('str');
    expect(shortType({ type: ['number', 'string'] })).toBe('num | str');
  });

  it('should handle enums', () => {
    expect(shortType({ enum: ['a', 'b', 'c'] })).toBe('enum');
  });

  it('should return "any" for invalid input', () => {
    expect(shortType(null as unknown as Record<string, unknown>)).toBe('any');
    expect(shortType(undefined as unknown as Record<string, unknown>)).toBe('any');
    expect(shortType({} as Record<string, unknown>)).toBe('any');
  });
});

describe('formatToolParamsInline', () => {
  it('should return () for empty or missing properties', () => {
    expect(formatToolParamsInline({ type: 'object', properties: {} })).toBe('()');
    expect(formatToolParamsInline({ type: 'object' })).toBe('()');
    expect(formatToolParamsInline({})).toBe('()');
  });

  it('should show required params before optional params', () => {
    const schema = {
      type: 'object',
      properties: {
        optional1: { type: 'string' },
        required1: { type: 'number' },
      },
      required: ['required1'],
    };
    expect(formatToolParamsInline(schema)).toBe('(required1:num, optional1?:str)');
  });

  it('should truncate to 3 params with ellipsis', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
        c: { type: 'string' },
        d: { type: 'string' },
      },
      required: ['a', 'b', 'c', 'd'],
    };
    expect(formatToolParamsInline(schema)).toBe('(a:str, b:str, c:str, \u2026)');
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
    expect(formatSimplifiedArgs(null as unknown as Record<string, unknown>)).toEqual(['* (none)']);
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

describe('formatTools', () => {
  const sampleTools: Tool[] = [
    {
      name: 'search_web',
      description: 'Search the web for information using DuckDuckGo and return relevant results',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          maxResults: { type: 'number', description: 'Max results' },
          language: { type: 'string', description: 'Language code' },
        },
        required: ['query'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          results: { type: 'array' },
          total: { type: 'number' },
        },
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'run_actor',
      description: 'Run an Apify Actor with the given input',
      inputSchema: {
        type: 'object',
        properties: {
          actorId: { type: 'string' },
          input: { type: 'object' },
          memory: { type: 'number' },
          timeout: { type: 'number' },
          build: { type: 'string' },
        },
        required: ['actorId'],
      },
      outputSchema: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
          },
        },
      },
      annotations: {
        destructiveHint: true,
      },
    },
  ] as Tool[];

  describe('compact format (default)', () => {
    it('should show header with tool count', () => {
      const output = formatTools(sampleTools);
      expect(output).toContain('Tools (2):');
    });

    it('should show tool names in backticks', () => {
      const output = formatTools(sampleTools);
      expect(output).toContain('`search_web (');
      expect(output).toContain('`run_actor (');
    });

    it('should use * bullet character', () => {
      const output = formatTools(sampleTools);
      expect(output).toContain('* `');
    });

    it('should show inline parameters with short types after tool name', () => {
      const output = formatTools(sampleTools);
      // search_web: 1 required + 2 optional = 3 total, all shown
      expect(output).toContain('`search_web (query:str, maxResults?:num, language?:str)`');
      // run_actor: 1 required + 4 optional = 5 total, show first 3 + ellipsis
      expect(output).toContain('`run_actor (actorId:str, input?:obj, memory?:num, \u2026)`');
    });

    it('should show annotations after parameters', () => {
      const output = formatTools(sampleTools);
      expect(output).toContain('[read-only]');
      expect(output).toContain('[destructive]');
    });

    it('should show hint about --full flag', () => {
      const output = formatTools(sampleTools);
      expect(output).toContain('tools-list --full');
      expect(output).toContain('tools-get <name>');
    });

    it('should NOT show detailed input schema', () => {
      const output = formatTools(sampleTools);
      // Detailed format has "Input:" sections
      expect(output).not.toContain('Input:');
    });
  });

  describe('full format (with { full: true })', () => {
    it('should show detailed view with separators', () => {
      const output = formatTools(sampleTools, { full: true });
      expect(output).toContain('---');
    });

    it('should show Input sections', () => {
      const output = formatTools(sampleTools, { full: true });
      expect(output).toContain('Input:');
    });

    it('should show full parameter details with types', () => {
      const output = formatTools(sampleTools, { full: true });
      expect(output).toContain('`query`: string [required]');
      expect(output).toContain('`maxResults`: number');
    });

    it('should show full descriptions in code blocks', () => {
      const output = formatTools(sampleTools, { full: true });
      expect(output).toContain('Description:');
      expect(output).toContain('````');
      expect(output).toContain(
        'Search the web for information using DuckDuckGo and return relevant results'
      );
    });

    it('should NOT show hint about --full flag', () => {
      const output = formatTools(sampleTools, { full: true });
      expect(output).not.toContain('tools-list --full');
    });
  });

  describe('edge cases', () => {
    it('should handle tools with no parameters', () => {
      const tools: Tool[] = [
        {
          name: 'no_params_tool',
          description: 'A tool with no parameters',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      const output = formatTools(tools);
      expect(output).toContain('`no_params_tool ()`');
    });

    it('should handle tools with no description', () => {
      const tools: Tool[] = [
        {
          name: 'undocumented',
          inputSchema: {
            type: 'object',
            properties: { arg: { type: 'string' } },
          },
        },
      ];

      const output = formatTools(tools);
      expect(output).toContain('`undocumented (arg?:str)`');
    });

    it('should handle empty tools array', () => {
      const output = formatTools([]);
      expect(output).toContain('Tools (0):');
    });

    it('should show task mode for tools with task support', () => {
      const tools = [
        {
          name: 'optional_tool',
          description: 'A tool with optional task support',
          inputSchema: { type: 'object', properties: {} },
          execution: { taskSupport: 'optional' },
        },
        {
          name: 'required_tool',
          description: 'A tool with required task support',
          inputSchema: { type: 'object', properties: {} },
          execution: { taskSupport: 'required' },
        },
        {
          name: 'forbidden_tool',
          description: 'A tool with forbidden task support',
          inputSchema: { type: 'object', properties: {} },
          execution: { taskSupport: 'forbidden' },
        },
        {
          name: 'sync_tool',
          description: 'A regular tool',
          inputSchema: { type: 'object', properties: {} },
        },
      ] as Tool[];

      const output = formatTools(tools);
      expect(output).toContain('`optional_tool ()` [task:optional]');
      expect(output).toContain('`required_tool ()` [task:required]');
      expect(output).not.toContain('`forbidden_tool ()` [');
      expect(output).not.toContain('`sync_tool ()` [');
    });

    it('should show all params when 3 or fewer total', () => {
      const tools: Tool[] = [
        {
          name: 'simple_tool',
          inputSchema: {
            type: 'object',
            properties: {
              a: { type: 'string' },
              b: { type: 'number' },
              c: { type: 'boolean' },
            },
            required: ['a'],
          },
        },
      ] as Tool[];

      const output = formatTools(tools);
      expect(output).toContain('`simple_tool (a:str, b?:num, c?:bool)`');
    });

    it('should show at most 3 params with ellipsis for the rest', () => {
      const tools: Tool[] = [
        {
          name: 'many_required',
          inputSchema: {
            type: 'object',
            properties: {
              a: { type: 'string' },
              b: { type: 'string' },
              c: { type: 'string' },
              d: { type: 'string' },
              e: { type: 'number' },
            },
            required: ['a', 'b', 'c', 'd'],
          },
        },
      ] as Tool[];

      const output = formatTools(tools);
      // Required params first, then optional; max 3 shown + ellipsis
      expect(output).toContain('`many_required (a:str, b:str, c:str, \u2026)`');
    });

    it('should combine annotations and task indicator', () => {
      const tools = [
        {
          name: 'combined_tool',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true },
          execution: { taskSupport: 'required' },
        },
      ] as Tool[];

      const output = formatTools(tools);
      expect(output).toContain('[read-only, task:required]');
    });
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

  it('should omit Description section when description is missing', () => {
    const tool: Tool = {
      name: 'undocumented-tool',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    };

    const output = formatToolDetail(tool);

    // Description section should be omitted when no description
    expect(output).not.toContain('Description:');
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

describe('formatToolCallExample', () => {
  it('should show required params and fill optional up to 3', () => {
    const tool: Tool = {
      name: 'read_file',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          encoding: { type: 'string', default: 'utf-8' },
          tail: { type: 'integer', minimum: 0 },
        },
        required: ['path'],
      },
    };

    const output = formatToolCallExample(tool, '@fs');
    expect(output).not.toBeNull();
    expect(output).toContain('tools-call read_file');
    expect(output).toContain('@fs');
    expect(output).toContain(`path:='"something"'`);
    expect(output).toContain(`encoding:='"utf-8"'`);
    expect(output).toContain('tail:=0');
  });

  it('should use default values when available', () => {
    const tool: Tool = {
      name: 'search',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', default: 10 },
        },
        required: ['query'],
      },
    };

    const output = formatToolCallExample(tool, '@test');
    expect(output).toContain(`query:='"something"'`);
    expect(output).toContain('limit:=10');
  });

  it('should show example for tool with no parameters', () => {
    const tool: Tool = {
      name: 'ping',
      inputSchema: { type: 'object', properties: {} },
    };

    const output = formatToolCallExample(tool, '@srv');
    expect(output).not.toBeNull();
    expect(output).toContain('tools-call ping');
    // Should NOT contain any key:= pairs
    expect(output).not.toContain(':=');
  });

  it('should use enum first value as example', () => {
    const tool: Tool = {
      name: 'set-mode',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['fast', 'slow', 'normal'] },
        },
        required: ['mode'],
      },
    };

    const output = formatToolCallExample(tool, '@s');
    expect(output).toContain(`mode:='"fast"'`);
  });

  it('should use placeholder <@session> when no session name provided', () => {
    const tool: Tool = {
      name: 'test',
      inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
    };

    const output = formatToolCallExample(tool);
    expect(output).toContain('<@session>');
  });

  it('should include --task for task:required tools', () => {
    const tool = {
      name: 'long-run',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      execution: { taskSupport: 'required' },
    } as unknown as Tool;

    const output = formatToolCallExample(tool, '@s');
    expect(output).toContain('--task');
    expect(output).not.toContain('[--task]');
  });

  it('should include [--task] for task:optional tools', () => {
    const tool = {
      name: 'maybe-async',
      inputSchema: { type: 'object', properties: {} },
      execution: { taskSupport: 'optional' },
    } as unknown as Tool;

    const output = formatToolCallExample(tool, '@s');
    expect(output).toContain('[--task]');
  });

  it('should shell-quote array default values so they survive shell parsing', () => {
    // Regression: array defaults like ["markdown"] were being rendered without
    // shell quoting, so the shell stripped the inner double quotes and mcpc
    // received `[markdown]`, which is not valid JSON.
    const tool: Tool = {
      name: 'rag-web-browser',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          outputFormats: { type: 'array', default: ['markdown'] },
        },
        required: ['query'],
      },
    };

    const output = formatToolCallExample(tool, '@apify');
    expect(output).toContain(`outputFormats:='["markdown"]'`);
  });

  it('should shell-quote object default values', () => {
    const tool: Tool = {
      name: 'configure',
      inputSchema: {
        type: 'object',
        properties: {
          config: { type: 'object', default: { key: 'value' } },
        },
        required: ['config'],
      },
    };

    const output = formatToolCallExample(tool, '@s');
    expect(output).toContain(`config:='{"key":"value"}'`);
  });
});

describe('formatToolHints', () => {
  it('should combine annotations and task support', () => {
    const tool = {
      name: 'test',
      inputSchema: { type: 'object', properties: {} },
      annotations: { destructiveHint: true, openWorldHint: true },
      execution: { taskSupport: 'required' },
    } as unknown as Tool;

    const hints = formatToolHints(tool);
    expect(hints).toContain('destructive');
    expect(hints).toContain('open-world');
    expect(hints).toContain('task:required');
  });

  it('should return null when no annotations and no task support', () => {
    const tool: Tool = {
      name: 'plain',
      inputSchema: { type: 'object', properties: {} },
    };

    expect(formatToolHints(tool)).toBeNull();
  });

  it('should show only task support when no annotations', () => {
    const tool = {
      name: 'async-only',
      inputSchema: { type: 'object', properties: {} },
      execution: { taskSupport: 'optional' },
    } as unknown as Tool;

    const hints = formatToolHints(tool);
    expect(hints).toBe('task:optional');
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
    // shell is deprecated and no longer listed
    expect(output).not.toContain('mcpc @test shell');

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

    // With no capabilities, no commands are listed
    expect(output).not.toContain('Available commands:');
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
    expect(output).toContain('Resources (2):');

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
    expect(output).toContain('Resources (0):');
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
    // @ts-ignore
    const resource: Resource = {
      uri: 'test://minimal',
    };

    const output = formatResourceDetail(resource);

    expect(output).toContain('Resource:');
    expect(output).toContain('`test://minimal`');
    expect(output).not.toContain('Name:');
    expect(output).not.toContain('MIME type:');
    // No description section when description is missing
    expect(output).not.toContain('Description:');
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
    expect(output).toContain('Resource templates (2):');

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
        arguments: [{ name: 'name', description: 'Name to greet', required: true }],
      },
      {
        name: 'farewell',
        description: 'Generate a farewell',
      },
    ];

    const output = formatPrompts(prompts);

    // Should have header with count
    expect(output).toContain('Prompts (2):');

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
    // No description section when description is missing
    expect(output).not.toContain('Description:');
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
      messages: [{ id: 1, text: 'not a prompt message' }],
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
    expect(output).not.toContain('HTTP');
    expect(output).toContain('OAuth');
    expect(output).toContain('default');
    expect(output).not.toContain('MCP:');
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
    expect(output).not.toContain('stdio');
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
  let consoleSpy: MockInstance;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should not output anything in json mode', async () => {
    await logTarget('@test', {
      outputMode: 'json',
    });

    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('should not output anything when hide is true', async () => {
    await logTarget('@test', {
      outputMode: 'human',
      hide: true,
    });

    expect(consoleSpy).not.toHaveBeenCalled();
  });
});

describe('truncateOutput', () => {
  // Import dynamically to avoid chalk mock issues
  let truncateOutput: (output: string, maxChars: number) => string;

  beforeAll(async () => {
    const mod = await import('../../../src/cli/output.js');
    truncateOutput = mod.truncateOutput;
  });

  it('returns original string when within limit', () => {
    expect(truncateOutput('short', 100)).toBe('short');
  });

  it('returns original string when exactly at limit', () => {
    const str = 'a'.repeat(100);
    expect(truncateOutput(str, 100)).toBe(str);
  });

  it('truncates long strings with a notice', () => {
    const str = 'a'.repeat(2000);
    const result = truncateOutput(str, 100);
    expect(result.length).toBeLessThan(str.length);
    expect(result).toContain('output truncated');
    expect(result).toContain('--max-chars');
    // Should show KB size for large outputs
    expect(result).toContain('2.0KB total');
  });

  it('shows character count for small outputs', () => {
    const str = 'a'.repeat(200);
    const result = truncateOutput(str, 50);
    expect(result).toContain('200 chars');
  });
});

describe('formatCallToolResultHuman', () => {
  it('should format single text content', () => {
    const result = {
      content: [{ type: 'text' as const, text: 'Hello world' }],
    };
    const output = formatCallToolResultHuman(result);
    expect(output).toContain('Content:');
    expect(output).toContain('````');
    expect(output).toContain('Hello world');
  });

  it('should format multiple text content blocks separately', () => {
    const result = {
      content: [
        { type: 'text' as const, text: 'First block' },
        { type: 'text' as const, text: 'Second block' },
      ],
    };
    const output = formatCallToolResultHuman(result);
    expect(output).toContain('Content:');
    expect(output).toContain('First block');
    expect(output).toContain('Second block');
    // Each block gets its own backtick wrapper
    const backtickCount = (output.match(/````/g) || []).length;
    expect(backtickCount).toBe(4); // open+close for each of the 2 blocks
  });

  it('should show Metadata section when _meta is present', () => {
    const result = {
      content: [{ type: 'text' as const, text: 'data' }],
      _meta: { usageTotalUsd: 0.005 },
    };
    const output = formatCallToolResultHuman(result);
    expect(output).toContain('Metadata');
    expect(output).toContain('usageTotalUsd');
    expect(output).toContain('0.005');
    expect(output).toContain('Content:');
  });

  it('should skip Metadata section when _meta is empty', () => {
    const result = {
      content: [{ type: 'text' as const, text: 'data' }],
      _meta: {},
    };
    const output = formatCallToolResultHuman(result);
    expect(output).not.toContain('Metadata');
  });

  it('should show structuredContent as JSON when content is empty', () => {
    const result = {
      content: [],
      structuredContent: { key: 'value' },
    };
    const output = formatCallToolResultHuman(result);
    expect(output).toContain('Structured content:');
    expect(output).toContain('"key"');
    expect(output).toContain('"value"');
  });

  it('should skip structuredContent when visible Content is present', () => {
    const result = {
      content: [{ type: 'text' as const, text: 'data' }],
      structuredContent: { key: 'value' },
    };
    const output = formatCallToolResultHuman(result);
    // Content already conveys the result — Structured content is redundant
    // verbose output and is suppressed (use --json for the full payload).
    expect(output).toContain('Content:');
    expect(output).toContain('data');
    expect(output).not.toContain('Structured content');
  });

  it('should not show structuredContent section when empty', () => {
    const result = {
      content: [{ type: 'text' as const, text: 'data' }],
      structuredContent: {},
    };
    const output = formatCallToolResultHuman(result);
    expect(output).not.toContain('Structured content');
  });

  it('should skip the duplicate text block when it matches structuredContent', () => {
    const sc = { results: [{ title: 'Test', url: 'https://example.com' }] };
    const result = {
      content: [{ type: 'text' as const, text: JSON.stringify(sc) }],
      structuredContent: sc,
    };
    const output = formatCallToolResultHuman(result);
    // The duplicate text block is omitted; structuredContent section is shown instead
    expect(output).not.toContain('Content:');
    expect(output).toContain('Structured content:');
    expect(output).toContain('"results"');
  });

  it('should skip duplicate text block even when pretty-printed', () => {
    const sc = { a: 1, b: 2 };
    const result = {
      content: [{ type: 'text' as const, text: JSON.stringify(sc, null, 2) }],
      structuredContent: sc,
    };
    const output = formatCallToolResultHuman(result);
    expect(output).not.toContain('Content:');
    expect(output).toContain('Structured content:');
  });

  it('should keep non-matching text blocks and suppress structuredContent', () => {
    const result = {
      content: [{ type: 'text' as const, text: 'Human-readable summary' }],
      structuredContent: { results: [1, 2, 3] },
    };
    const output = formatCallToolResultHuman(result);
    expect(output).toContain('Content:');
    expect(output).toContain('Human-readable summary');
    expect(output).not.toContain('Structured content');
  });

  it('should show structuredContent when there are no content blocks', () => {
    const result = {
      content: [],
      structuredContent: { answer: 42 },
    };
    const output = formatCallToolResultHuman(result);
    expect(output).toContain('Structured content:');
    expect(output).toContain('"answer"');
    expect(output).toContain('42');
  });

  it('should only skip the matching text block among multiple blocks', () => {
    const sc = { key: 'val' };
    const result = {
      content: [
        { type: 'text' as const, text: 'Summary' },
        { type: 'text' as const, text: JSON.stringify(sc) },
      ],
      structuredContent: sc,
    };
    const output = formatCallToolResultHuman(result);
    // The first text block (non-matching) is kept; the JSON duplicate is omitted.
    // Since visible Content remains, Structured content is suppressed too.
    expect(output).toContain('Content:');
    expect(output).toContain('Summary');
    expect(output).not.toContain('Structured content');
  });

  it('should format resource_link content blocks', () => {
    const result = {
      content: [
        {
          type: 'resource_link' as const,
          uri: 'file:///project/src/main.rs',
          name: 'main.rs',
          description: 'Entry point',
          mimeType: 'text/x-rust',
        },
      ],
    };
    const output = formatCallToolResultHuman(result);
    expect(output).toContain('Resource link');
    expect(output).toContain('file:///project/src/main.rs');
    expect(output).toContain('main.rs');
    expect(output).toContain('Entry point');
    expect(output).toContain('text/x-rust');
  });

  it('should format image content blocks', () => {
    const result = {
      content: [
        {
          type: 'image' as const,
          data: 'aGVsbG8=',
          mimeType: 'image/png',
        },
      ],
    };
    const output = formatCallToolResultHuman(result);
    expect(output).toContain('[Image: image/png');
    expect(output).toContain('base64');
  });

  it('should format audio content blocks', () => {
    const result = {
      content: [
        {
          type: 'audio' as const,
          data: 'YXVkaW8=',
          mimeType: 'audio/mp3',
        },
      ],
    };
    const output = formatCallToolResultHuman(result);
    expect(output).toContain('[Audio: audio/mp3');
  });

  it('should format embedded resource content blocks', () => {
    const result = {
      content: [
        {
          type: 'resource' as const,
          resource: {
            uri: 'file:///data.json',
            mimeType: 'application/json',
            text: '{"key":"value"}',
          },
        },
      ],
    };
    const output = formatCallToolResultHuman(result);
    expect(output).toContain('Embedded resource');
    expect(output).toContain('file:///data.json');
    expect(output).toContain('application/json');
    expect(output).toContain('{"key":"value"}');
  });

  it('should return "(no content)" when result is empty', () => {
    const result = {
      content: [],
    };
    const output = formatCallToolResultHuman(result);
    expect(output).toContain('(no content)');
  });

  it('should show Content and Metadata (and suppress structuredContent) when content is non-empty', () => {
    const result = {
      _meta: { cost: 0.01 },
      content: [
        { type: 'text' as const, text: 'Some output' },
        {
          type: 'resource_link' as const,
          uri: 'file:///a.txt',
          name: 'a.txt',
        },
      ],
      structuredContent: { parsed: true },
    };
    const output = formatCallToolResultHuman(result);

    expect(output).toContain('Content:');
    expect(output).toContain('Some output');
    expect(output).toContain('Resource link');
    expect(output).toContain('Metadata:');
    expect(output).toContain('"cost"');
    // Structured content is redundant when Content already conveys the result
    expect(output).not.toContain('Structured content');

    // Correct ordering: Content → Metadata
    expect(output.indexOf('Content:')).toBeLessThan(output.indexOf('Metadata:'));
  });

  it('should show Structured content and Metadata when content is empty', () => {
    const result = {
      _meta: { cost: 0.01 },
      content: [],
      structuredContent: { parsed: true },
    };
    const output = formatCallToolResultHuman(result);

    expect(output).not.toContain('Content:');
    expect(output).toContain('Structured content:');
    expect(output).toContain('"parsed"');
    expect(output).toContain('Metadata:');
    expect(output).toContain('"cost"');

    // Correct ordering: Structured content → Metadata
    expect(output.indexOf('Structured content:')).toBeLessThan(output.indexOf('Metadata:'));
  });
});
