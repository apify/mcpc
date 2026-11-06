/**
 * Unit tests for schema validation module
 */

import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadSchemaFromFile,
  validateToolSchema,
  validatePromptSchema,
  formatValidationError,
  type ToolSchema,
  type PromptSchema,
} from '../../src/lib/schema-validator.js';

describe('schema-validator', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `schema-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup is best-effort
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('loadSchemaFromFile', () => {
    it('loads valid JSON schema file', async () => {
      const schemaPath = join(tempDir, 'schema.json');
      const schema = { name: 'test', description: 'A test tool' };
      await writeFile(schemaPath, JSON.stringify(schema));

      const loaded = await loadSchemaFromFile(schemaPath);
      expect(loaded).toEqual(schema);
    });

    it('throws error for non-existent file', async () => {
      await expect(loadSchemaFromFile('/nonexistent/path.json')).rejects.toThrow(
        'Schema file not found'
      );
    });

    it('throws error for invalid JSON', async () => {
      const schemaPath = join(tempDir, 'invalid.json');
      await writeFile(schemaPath, 'not valid json');

      await expect(loadSchemaFromFile(schemaPath)).rejects.toThrow('Invalid JSON');
    });
  });

  describe('validateToolSchema', () => {
    const baseSchema: ToolSchema = {
      name: 'echo',
      description: 'Echo a message',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
        },
        required: ['message'],
      },
    };

    it('returns valid for identical schemas in strict mode', () => {
      const result = validateToolSchema(baseSchema, baseSchema, 'strict');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('returns valid for identical schemas in compatible mode', () => {
      const result = validateToolSchema(baseSchema, baseSchema, 'compatible');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('returns valid in ignore mode regardless of differences', () => {
      const differentSchema: ToolSchema = {
        name: 'different',
        description: 'Completely different',
      };
      const result = validateToolSchema(baseSchema, differentSchema, 'ignore');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('detects name mismatch', () => {
      const expected: ToolSchema = { ...baseSchema, name: 'different-name' };
      const result = validateToolSchema(baseSchema, expected, 'compatible');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('name mismatch'))).toBe(true);
    });

    it('detects description mismatch in strict mode', () => {
      const expected: ToolSchema = { ...baseSchema, description: 'Different description' };
      const result = validateToolSchema(baseSchema, expected, 'strict');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Description mismatch'))).toBe(true);
    });

    it('detects outputSchema mismatch in strict mode', () => {
      const actual: ToolSchema = {
        ...baseSchema,
        outputSchema: {
          type: 'object',
          properties: { result: { type: 'string' } },
        },
      };
      const expected: ToolSchema = {
        ...baseSchema,
        outputSchema: {
          type: 'object',
          properties: { result: { type: 'number' } },
        },
      };
      const result = validateToolSchema(actual, expected, 'strict');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Output schema does not match'))).toBe(true);
    });

    it('passes strict mode when outputSchema matches exactly', () => {
      const schemaWithOutput: ToolSchema = {
        ...baseSchema,
        outputSchema: {
          type: 'object',
          properties: { result: { type: 'string' } },
        },
      };
      const result = validateToolSchema(schemaWithOutput, schemaWithOutput, 'strict');
      expect(result.valid).toBe(true);
    });

    it('detects outputSchema type change in compatible mode', () => {
      const actual: ToolSchema = {
        ...baseSchema,
        outputSchema: {
          type: 'object',
          properties: { result: { type: 'string' } },
        },
      };
      const expected: ToolSchema = {
        ...baseSchema,
        outputSchema: {
          type: 'object',
          properties: { result: { type: 'number' } },
        },
      };
      const result = validateToolSchema(actual, expected, 'compatible');
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => e.includes('Output field') && e.includes('type changed'))
      ).toBe(true);
    });

    it('allows description mismatch in compatible mode with warning', () => {
      const actual: ToolSchema = { ...baseSchema, description: 'Actual description' };
      const expected: ToolSchema = { ...baseSchema, description: 'Expected description' };
      const result = validateToolSchema(actual, expected, 'compatible');
      // Name matches, so should be valid (description produces warning, not error)
      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes('Description changed'))).toBe(true);
    });

    describe('outputSchema validation in compatible mode', () => {
      it('detects removed output field', () => {
        const expected: ToolSchema = {
          ...baseSchema,
          outputSchema: {
            type: 'object',
            properties: {
              result: { type: 'string' },
              extra: { type: 'number' },
            },
          },
        };
        const actual: ToolSchema = {
          ...baseSchema,
          outputSchema: {
            type: 'object',
            properties: {
              result: { type: 'string' },
              // extra removed
            },
          },
        };
        const result = validateToolSchema(actual, expected, 'compatible');
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('extra') && e.includes('removed'))).toBe(true);
      });

      it('warns about new output fields', () => {
        const expected: ToolSchema = {
          ...baseSchema,
          outputSchema: {
            type: 'object',
            properties: {
              result: { type: 'string' },
            },
          },
        };
        const actual: ToolSchema = {
          ...baseSchema,
          outputSchema: {
            type: 'object',
            properties: {
              result: { type: 'string' },
              newField: { type: 'number' },
            },
          },
        };
        const result = validateToolSchema(actual, expected, 'compatible');
        expect(result.valid).toBe(true);
        expect(result.warnings.some((w) => w.includes('newField') && w.includes('added'))).toBe(
          true
        );
      });

      it('warns when required output field becomes optional', () => {
        const expected: ToolSchema = {
          ...baseSchema,
          outputSchema: {
            type: 'object',
            properties: {
              result: { type: 'string' },
            },
            required: ['result'],
          },
        };
        const actual: ToolSchema = {
          ...baseSchema,
          outputSchema: {
            type: 'object',
            properties: {
              result: { type: 'string' },
            },
            required: [], // result no longer required
          },
        };
        const result = validateToolSchema(actual, expected, 'compatible');
        expect(result.valid).toBe(true);
        expect(
          result.warnings.some((w) => w.includes('result') && w.includes('required to optional'))
        ).toBe(true);
      });

      it('warns when optional output field becomes required (not breaking)', () => {
        const expected: ToolSchema = {
          ...baseSchema,
          outputSchema: {
            type: 'object',
            properties: {
              result: { type: 'string' },
            },
            required: [],
          },
        };
        const actual: ToolSchema = {
          ...baseSchema,
          outputSchema: {
            type: 'object',
            properties: {
              result: { type: 'string' },
            },
            required: ['result'], // result now required
          },
        };
        const result = validateToolSchema(actual, expected, 'compatible');
        expect(result.valid).toBe(true);
        expect(
          result.warnings.some((w) => w.includes('result') && w.includes('optional to required'))
        ).toBe(true);
      });

      it('fails when output schema is completely removed', () => {
        const expected: ToolSchema = {
          ...baseSchema,
          outputSchema: {
            type: 'object',
            properties: { result: { type: 'string' } },
          },
        };
        const actual: ToolSchema = {
          ...baseSchema,
          // outputSchema removed
        };
        const result = validateToolSchema(actual, expected, 'compatible');
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('Output schema was removed'))).toBe(true);
      });

      it('warns when output schema is added', () => {
        const expected: ToolSchema = {
          ...baseSchema,
          // no outputSchema
        };
        const actual: ToolSchema = {
          ...baseSchema,
          outputSchema: {
            type: 'object',
            properties: { result: { type: 'string' } },
          },
        };
        const result = validateToolSchema(actual, expected, 'compatible');
        expect(result.valid).toBe(true);
        expect(result.warnings.some((w) => w.includes('Output schema was added'))).toBe(true);
      });

      it('passes when outputSchemas match exactly', () => {
        const schemaWithOutput: ToolSchema = {
          ...baseSchema,
          outputSchema: {
            type: 'object',
            properties: { result: { type: 'string' } },
            required: ['result'],
          },
        };
        const result = validateToolSchema(schemaWithOutput, schemaWithOutput, 'compatible');
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });
    });

    it('detects missing required field', () => {
      const actual: ToolSchema = {
        ...baseSchema,
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: [], // message no longer required
        },
      };
      const result = validateToolSchema(actual, baseSchema, 'compatible');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('no longer required'))).toBe(true);
    });

    it('detects new required field (breaking change)', () => {
      const actual: ToolSchema = {
        ...baseSchema,
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            newField: { type: 'string' },
          },
          required: ['message', 'newField'],
        },
      };
      const result = validateToolSchema(actual, baseSchema, 'compatible');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('New required field'))).toBe(true);
    });

    it('warns about new optional fields in compatible mode', () => {
      const actual: ToolSchema = {
        ...baseSchema,
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            optional: { type: 'string' },
          },
          required: ['message'],
        },
      };
      const result = validateToolSchema(actual, baseSchema, 'compatible');
      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes('optional'))).toBe(true);
    });

    it('detects missing property', () => {
      const actual: ToolSchema = {
        name: 'echo',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      };
      const result = validateToolSchema(actual, baseSchema, 'compatible');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('missing'))).toBe(true);
    });

    it('detects type change', () => {
      const actual: ToolSchema = {
        ...baseSchema,
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'number' }, // Changed from string to number
          },
          required: ['message'],
        },
      };
      const result = validateToolSchema(actual, baseSchema, 'compatible');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('type changed'))).toBe(true);
    });

    describe('with passedArgs option', () => {
      it('validates only passed arguments in compatible mode', () => {
        const expected: ToolSchema = {
          name: 'multi-arg',
          inputSchema: {
            type: 'object',
            properties: {
              arg1: { type: 'string' },
              arg2: { type: 'number' },
            },
            required: ['arg1'],
          },
        };
        const actual: ToolSchema = {
          name: 'multi-arg',
          inputSchema: {
            type: 'object',
            properties: {
              arg1: { type: 'string' },
              arg2: { type: 'string' }, // Type changed but not passed
            },
            required: ['arg1'],
          },
        };
        // Only passing arg1, so arg2 type change should be ignored
        const result = validateToolSchema(actual, expected, 'compatible', { arg1: 'hello' });
        expect(result.valid).toBe(true);
      });

      it('detects type change for passed arguments', () => {
        const expected: ToolSchema = {
          name: 'multi-arg',
          inputSchema: {
            type: 'object',
            properties: {
              arg1: { type: 'string' },
              arg2: { type: 'number' },
            },
            required: [],
          },
        };
        const actual: ToolSchema = {
          name: 'multi-arg',
          inputSchema: {
            type: 'object',
            properties: {
              arg1: { type: 'string' },
              arg2: { type: 'string' }, // Type changed
            },
            required: [],
          },
        };
        // Passing arg2, so type change should be detected
        const result = validateToolSchema(actual, expected, 'compatible', { arg2: 123 });
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('arg2') && e.includes('type changed'))).toBe(
          true
        );
      });

      it('detects when passed argument no longer exists', () => {
        const expected: ToolSchema = {
          name: 'tool',
          inputSchema: {
            type: 'object',
            properties: {
              arg1: { type: 'string' },
              arg2: { type: 'string' },
            },
            required: [],
          },
        };
        const actual: ToolSchema = {
          name: 'tool',
          inputSchema: {
            type: 'object',
            properties: {
              arg1: { type: 'string' },
              // arg2 removed
            },
            required: [],
          },
        };
        const result = validateToolSchema(actual, expected, 'compatible', { arg2: 'value' });
        expect(result.valid).toBe(false);
        expect(
          result.errors.some((e) => e.includes('arg2') && e.includes('no longer exists'))
        ).toBe(true);
      });

      it('allows new required field if it is being passed', () => {
        const expected: ToolSchema = {
          name: 'tool',
          inputSchema: {
            type: 'object',
            properties: {
              arg1: { type: 'string' },
            },
            required: ['arg1'],
          },
        };
        const actual: ToolSchema = {
          name: 'tool',
          inputSchema: {
            type: 'object',
            properties: {
              arg1: { type: 'string' },
              newRequired: { type: 'string' },
            },
            required: ['arg1', 'newRequired'], // New required field
          },
        };
        // Passing the new required field, so it should be valid
        const result = validateToolSchema(actual, expected, 'compatible', {
          arg1: 'hello',
          newRequired: 'world',
        });
        expect(result.valid).toBe(true);
      });

      it('fails for new required field not being passed', () => {
        const expected: ToolSchema = {
          name: 'tool',
          inputSchema: {
            type: 'object',
            properties: {
              arg1: { type: 'string' },
            },
            required: ['arg1'],
          },
        };
        const actual: ToolSchema = {
          name: 'tool',
          inputSchema: {
            type: 'object',
            properties: {
              arg1: { type: 'string' },
              newRequired: { type: 'string' },
            },
            required: ['arg1', 'newRequired'], // New required field
          },
        };
        // Not passing the new required field
        const result = validateToolSchema(actual, expected, 'compatible', { arg1: 'hello' });
        expect(result.valid).toBe(false);
        expect(
          result.errors.some((e) => e.includes('newRequired') && e.includes('breaking change'))
        ).toBe(true);
      });
    });
  });

  describe('validatePromptSchema', () => {
    const baseSchema: PromptSchema = {
      name: 'greeting',
      description: 'Generate a greeting',
      arguments: [
        { name: 'name', description: 'Name to greet', required: true },
        { name: 'style', description: 'Greeting style', required: false },
      ],
    };

    it('returns valid for identical schemas in strict mode', () => {
      const result = validatePromptSchema(baseSchema, baseSchema, 'strict');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('returns valid for identical schemas in compatible mode', () => {
      const result = validatePromptSchema(baseSchema, baseSchema, 'compatible');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('returns valid in ignore mode regardless of differences', () => {
      const differentSchema: PromptSchema = {
        name: 'different',
        arguments: [],
      };
      const result = validatePromptSchema(baseSchema, differentSchema, 'ignore');
      expect(result.valid).toBe(true);
    });

    it('detects name mismatch', () => {
      const expected: PromptSchema = { ...baseSchema, name: 'different-prompt' };
      const result = validatePromptSchema(baseSchema, expected, 'compatible');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('name mismatch'))).toBe(true);
    });

    it('detects missing required argument', () => {
      const actual: PromptSchema = {
        ...baseSchema,
        arguments: [{ name: 'style', description: 'Greeting style', required: false }],
      };
      const result = validatePromptSchema(actual, baseSchema, 'compatible');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('missing'))).toBe(true);
    });

    it('detects required argument becoming optional', () => {
      const actual: PromptSchema = {
        ...baseSchema,
        arguments: [
          { name: 'name', description: 'Name to greet', required: false }, // Changed to optional
          { name: 'style', description: 'Greeting style', required: false },
        ],
      };
      const result = validatePromptSchema(actual, baseSchema, 'compatible');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('no longer required'))).toBe(true);
    });

    it('detects new required argument (breaking change)', () => {
      const actual: PromptSchema = {
        ...baseSchema,
        arguments: [
          { name: 'name', description: 'Name to greet', required: true },
          { name: 'style', description: 'Greeting style', required: false },
          { name: 'newRequired', description: 'New required arg', required: true },
        ],
      };
      const result = validatePromptSchema(actual, baseSchema, 'compatible');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('New required argument'))).toBe(true);
    });

    it('warns about new optional arguments in compatible mode', () => {
      const actual: PromptSchema = {
        ...baseSchema,
        arguments: [
          { name: 'name', description: 'Name to greet', required: true },
          { name: 'style', description: 'Greeting style', required: false },
          { name: 'newOptional', description: 'New optional arg', required: false },
        ],
      };
      const result = validatePromptSchema(actual, baseSchema, 'compatible');
      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes('newOptional'))).toBe(true);
    });

    describe('with passedArgs option', () => {
      it('validates only passed arguments in compatible mode', () => {
        const expected: PromptSchema = {
          name: 'test',
          arguments: [
            { name: 'arg1', required: true },
            { name: 'arg2', required: false },
          ],
        };
        const actual: PromptSchema = {
          name: 'test',
          arguments: [
            { name: 'arg1', required: true },
            // arg2 removed but not being passed
          ],
        };
        // Only passing arg1, so arg2 removal should be ignored
        const result = validatePromptSchema(actual, expected, 'compatible', { arg1: 'hello' });
        expect(result.valid).toBe(true);
      });

      it('detects when passed argument no longer exists', () => {
        const expected: PromptSchema = {
          name: 'test',
          arguments: [
            { name: 'arg1', required: true },
            { name: 'arg2', required: false },
          ],
        };
        const actual: PromptSchema = {
          name: 'test',
          arguments: [
            { name: 'arg1', required: true },
            // arg2 removed
          ],
        };
        // Passing arg2, so its removal should be detected
        const result = validatePromptSchema(actual, expected, 'compatible', {
          arg1: 'hello',
          arg2: 'world',
        });
        expect(result.valid).toBe(false);
        expect(
          result.errors.some((e) => e.includes('arg2') && e.includes('no longer exists'))
        ).toBe(true);
      });

      it('allows new required argument if it is being passed', () => {
        const expected: PromptSchema = {
          name: 'test',
          arguments: [{ name: 'arg1', required: true }],
        };
        const actual: PromptSchema = {
          name: 'test',
          arguments: [
            { name: 'arg1', required: true },
            { name: 'newRequired', required: true }, // New required arg
          ],
        };
        // Passing the new required argument, so it should be valid
        const result = validatePromptSchema(actual, expected, 'compatible', {
          arg1: 'hello',
          newRequired: 'world',
        });
        expect(result.valid).toBe(true);
      });

      it('fails for new required argument not being passed', () => {
        const expected: PromptSchema = {
          name: 'test',
          arguments: [{ name: 'arg1', required: true }],
        };
        const actual: PromptSchema = {
          name: 'test',
          arguments: [
            { name: 'arg1', required: true },
            { name: 'newRequired', required: true }, // New required arg
          ],
        };
        // Not passing the new required argument
        const result = validatePromptSchema(actual, expected, 'compatible', { arg1: 'hello' });
        expect(result.valid).toBe(false);
        expect(
          result.errors.some((e) => e.includes('newRequired') && e.includes('breaking change'))
        ).toBe(true);
      });
    });
  });

  describe('formatValidationError', () => {
    it('formats single error', () => {
      const result = {
        valid: false,
        errors: ['Name mismatch: expected "foo", got "bar"'],
        warnings: [],
      };
      const formatted = formatValidationError(result, 'tool "test"');
      expect(formatted).toContain('Schema validation failed');
      expect(formatted).toContain('tool "test"');
      expect(formatted).toContain('Name mismatch');
    });

    it('formats multiple errors', () => {
      const result = {
        valid: false,
        errors: ['Error 1', 'Error 2'],
        warnings: [],
      };
      const formatted = formatValidationError(result, 'prompt "greeting"');
      expect(formatted).toContain('Error 1');
      expect(formatted).toContain('Error 2');
    });

    it('includes warnings section if present', () => {
      const result = {
        valid: false,
        errors: ['Error'],
        warnings: ['Warning 1', 'Warning 2'],
      };
      const formatted = formatValidationError(result, 'tool');
      expect(formatted).toContain('Warnings:');
      expect(formatted).toContain('Warning 1');
      expect(formatted).toContain('Warning 2');
    });
  });
});

describe('validateToolSchema with names inherited from Object.prototype', () => {
  const schema: ToolSchema = {
    name: 'one-arg',
    inputSchema: { type: 'object', properties: { arg1: { type: 'string' } } },
  };

  it('does not treat a passed "constructor" argument as a schema property', () => {
    const result = validateToolSchema(schema, schema, 'compatible', { constructor: 'x' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Argument "constructor" no longer exists in schema');
  });
});
