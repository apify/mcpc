/**
 * Unit tests for the dialect-aware JSON Schema validator
 */

import { DialectAwareJsonSchemaValidator } from '../../../src/core/json-schema-validator.js';

describe('DialectAwareJsonSchemaValidator', () => {
  const provider = new DialectAwareJsonSchemaValidator();

  it('validates a draft-07-stamped schema (2025-era servers) instead of rejecting the dialect', () => {
    // The exact shape zod-to-json-schema emits for v1 SDK servers such as
    // @modelcontextprotocol/server-filesystem — the default SDK validator throws
    // "unsupported dialect" for this.
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        content: { type: 'string' },
      },
      required: ['content'],
      additionalProperties: false,
    };

    const validate = provider.getValidator<{ content: string }>(schema);

    const good = validate({ content: 'hello' });
    expect(good.valid).toBe(true);
    expect(good.data).toEqual({ content: 'hello' });

    const bad = validate({ content: 42 });
    expect(bad.valid).toBe(false);
    expect(bad.errorMessage).toBeTruthy();
  });

  it('validates an unstamped schema with the default (2020-12) engine', () => {
    const schema = {
      type: 'object',
      properties: { n: { type: 'number' } },
      required: ['n'],
    };

    const validate = provider.getValidator<{ n: number }>(schema);
    expect(validate({ n: 1 }).valid).toBe(true);
    expect(validate({}).valid).toBe(false);
  });

  it('validates a 2020-12-stamped schema with the default engine', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { items: { type: 'array', prefixItems: [{ type: 'string' }] } },
    };

    const validate = provider.getValidator<{ items: unknown[] }>(schema);
    expect(validate({ items: ['a'] }).valid).toBe(true);
    expect(validate({ items: [42] }).valid).toBe(false);
  });
});
