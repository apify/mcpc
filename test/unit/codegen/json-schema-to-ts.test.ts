/**
 * Unit tests for JSON Schema to TypeScript converter
 */

import {
  jsonSchemaToTs,
  toPascalCase,
  toCamelCase,
  deduplicateNames,
  generateToolTypes,
  JsonSchema,
} from '../../../src/lib/codegen/typescript/json-schema-to-ts.js';

describe('toPascalCase', () => {
  it('should convert kebab-case to PascalCase', () => {
    expect(toPascalCase('search-actors')).toBe('SearchActors');
    expect(toPascalCase('get-user-by-id')).toBe('GetUserById');
  });

  it('should convert snake_case to PascalCase', () => {
    expect(toPascalCase('search_actors')).toBe('SearchActors');
    expect(toPascalCase('get_user_by_id')).toBe('GetUserById');
  });

  it('should handle already PascalCase (lowercases then capitalizes each word)', () => {
    expect(toPascalCase('SearchActors')).toBe('Searchactors');
  });

  it('should capitalize first letter of simple words', () => {
    expect(toPascalCase('search')).toBe('Search');
    expect(toPascalCase('actor')).toBe('Actor');
  });

  it('should handle spaces', () => {
    expect(toPascalCase('search actors')).toBe('SearchActors');
    expect(toPascalCase('Get User By ID')).toBe('GetUserById');
  });

  it('should handle multiple consecutive separators', () => {
    expect(toPascalCase('search--actors')).toBe('SearchActors');
    expect(toPascalCase('search__actors')).toBe('SearchActors');
    expect(toPascalCase('search  actors')).toBe('SearchActors');
  });

  it('should handle mixed separators', () => {
    expect(toPascalCase('search-actors_list')).toBe('SearchActorsList');
    expect(toPascalCase('get user-by_id')).toBe('GetUserById');
  });

  it('should handle special characters', () => {
    expect(toPascalCase('search!actors')).toBe('SearchActors');
    expect(toPascalCase('get@user#by$id')).toBe('GetUserById');
    expect(toPascalCase('hello.world')).toBe('HelloWorld');
  });

  it('should handle strings starting with numbers', () => {
    expect(toPascalCase('123search')).toBe('_123search');
    expect(toPascalCase('2factor-auth')).toBe('_2factorAuth');
  });

  it('should preserve numbers within the string', () => {
    expect(toPascalCase('get-user-v2')).toBe('GetUserV2');
    expect(toPascalCase('oauth2-login')).toBe('Oauth2Login');
  });

  it('should handle empty string', () => {
    expect(toPascalCase('')).toBe('Unknown');
  });

  it('should handle string with only special characters', () => {
    expect(toPascalCase('---')).toBe('Unknown');
    expect(toPascalCase('!!!')).toBe('Unknown');
  });

  it('should handle Unicode and emoji', () => {
    expect(toPascalCase('hello🌍world')).toBe('HelloWorld');
    expect(toPascalCase('über-search')).toBe('BerSearch');
  });
});

describe('toCamelCase', () => {
  it('should convert kebab-case to camelCase', () => {
    expect(toCamelCase('search-actors')).toBe('searchActors');
    expect(toCamelCase('get-user-by-id')).toBe('getUserById');
  });

  it('should convert snake_case to camelCase', () => {
    expect(toCamelCase('search_actors')).toBe('searchActors');
  });

  it('should lowercase first letter of PascalCase (lowercases then capitalizes each word)', () => {
    expect(toCamelCase('SearchActors')).toBe('searchactors');
  });

  it('should handle spaces', () => {
    expect(toCamelCase('search actors')).toBe('searchActors');
    expect(toCamelCase('Get User By ID')).toBe('getUserById');
  });

  it('should handle multiple consecutive separators', () => {
    expect(toCamelCase('search--actors')).toBe('searchActors');
    expect(toCamelCase('search__actors')).toBe('searchActors');
  });

  it('should handle special characters', () => {
    expect(toCamelCase('search!actors')).toBe('searchActors');
    expect(toCamelCase('hello.world')).toBe('helloWorld');
  });

  it('should handle strings starting with numbers', () => {
    expect(toCamelCase('123search')).toBe('_123search');
    expect(toCamelCase('2factor-auth')).toBe('_2factorAuth');
  });

  it('should handle empty string', () => {
    expect(toCamelCase('')).toBe('unknown');
  });

  it('should handle string with only special characters', () => {
    expect(toCamelCase('---')).toBe('unknown');
  });
});

describe('deduplicateNames', () => {
  it('should return unique names as-is', () => {
    const names = ['search', 'list', 'get'];
    const result = deduplicateNames(names);
    expect(result.get('search')).toBe('search');
    expect(result.get('list')).toBe('list');
    expect(result.get('get')).toBe('get');
  });

  it('should add numeric suffixes to duplicates', () => {
    const names = ['search-actors', 'search_actors', 'search actors'];
    const result = deduplicateNames(names);
    expect(result.get('search-actors')).toBe('searchActors');
    expect(result.get('search_actors')).toBe('searchActors2');
    expect(result.get('search actors')).toBe('searchActors3');
  });

  it('should handle multiple groups of duplicates', () => {
    const names = ['get-user', 'get_user', 'list-items', 'list_items'];
    const result = deduplicateNames(names);
    expect(result.get('get-user')).toBe('getUser');
    expect(result.get('get_user')).toBe('getUser2');
    expect(result.get('list-items')).toBe('listItems');
    expect(result.get('list_items')).toBe('listItems2');
  });

  it('should handle empty array', () => {
    const result = deduplicateNames([]);
    expect(result.size).toBe(0);
  });

  it('should handle single element', () => {
    const result = deduplicateNames(['search']);
    expect(result.get('search')).toBe('search');
  });

  it('should handle names that differ only in case', () => {
    const names = ['Search', 'search', 'SEARCH'];
    const result = deduplicateNames(names);
    expect(result.get('Search')).toBe('search');
    expect(result.get('search')).toBe('search2');
    expect(result.get('SEARCH')).toBe('search3');
  });
});

describe('jsonSchemaToTs - primitive types', () => {
  it('should convert string type', () => {
    const result = jsonSchemaToTs({ type: 'string' }, 'Test');
    expect(result.typeExpression).toBe('string');
    expect(result.declarations).toHaveLength(0);
  });

  it('should convert number type', () => {
    const result = jsonSchemaToTs({ type: 'number' }, 'Test');
    expect(result.typeExpression).toBe('number');
  });

  it('should convert integer type to number', () => {
    const result = jsonSchemaToTs({ type: 'integer' }, 'Test');
    expect(result.typeExpression).toBe('number');
  });

  it('should convert boolean type', () => {
    const result = jsonSchemaToTs({ type: 'boolean' }, 'Test');
    expect(result.typeExpression).toBe('boolean');
  });

  it('should convert null type', () => {
    const result = jsonSchemaToTs({ type: 'null' }, 'Test');
    expect(result.typeExpression).toBe('null');
  });
});

describe('jsonSchemaToTs - union types', () => {
  it('should convert type array to union', () => {
    const result = jsonSchemaToTs({ type: ['string', 'null'] }, 'Test');
    expect(result.typeExpression).toBe('string | null');
  });

  it('should convert multiple type array', () => {
    const result = jsonSchemaToTs({ type: ['string', 'number', 'boolean'] }, 'Test');
    expect(result.typeExpression).toBe('string | number | boolean');
  });
});

describe('jsonSchemaToTs - enums', () => {
  it('should convert string enum', () => {
    const result = jsonSchemaToTs({ enum: ['active', 'inactive', 'pending'] }, 'Status');
    expect(result.typeExpression).toBe("'active' | 'inactive' | 'pending'");
  });

  it('should convert number enum', () => {
    const result = jsonSchemaToTs({ enum: [1, 2, 3] }, 'Level');
    expect(result.typeExpression).toBe('1 | 2 | 3');
  });

  it('should convert mixed enum', () => {
    const result = jsonSchemaToTs({ enum: ['auto', 1, true, null] }, 'Mixed');
    expect(result.typeExpression).toBe("'auto' | 1 | true | null");
  });

  it('should escape special characters in string enum', () => {
    const result = jsonSchemaToTs({ enum: ["it's", 'line\nbreak'] }, 'Special');
    expect(result.typeExpression).toBe("'it\\'s' | 'line\\nbreak'");
  });
});

describe('jsonSchemaToTs - arrays', () => {
  it('should convert array of strings', () => {
    const result = jsonSchemaToTs({ type: 'array', items: { type: 'string' } }, 'Tags');
    expect(result.typeExpression).toBe('string[]');
  });

  it('should convert array of numbers', () => {
    const result = jsonSchemaToTs({ type: 'array', items: { type: 'number' } }, 'Scores');
    expect(result.typeExpression).toBe('number[]');
  });

  it('should convert array without items to unknown[]', () => {
    const result = jsonSchemaToTs({ type: 'array' }, 'Items');
    expect(result.typeExpression).toBe('unknown[]');
  });

  it('should convert nested arrays', () => {
    const schema: JsonSchema = {
      type: 'array',
      items: {
        type: 'array',
        items: { type: 'string' },
      },
    };
    const result = jsonSchemaToTs(schema, 'Matrix');
    expect(result.typeExpression).toBe('string[][]');
  });

  it('should convert array of objects', () => {
    const schema: JsonSchema = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['id'],
      },
    };
    const result = jsonSchemaToTs(schema, 'Users');
    expect(result.typeExpression).toBe('UsersItem[]');
    expect(result.declarations).toHaveLength(1);
    expect(result.declarations[0]).toContain('export interface UsersItem');
    expect(result.declarations[0]).toContain('id: string');
    expect(result.declarations[0]).toContain('name?: string');
  });
});

describe('jsonSchemaToTs - objects', () => {
  it('should convert empty object to Record<string, unknown>', () => {
    const result = jsonSchemaToTs({ type: 'object' }, 'Data');
    expect(result.typeExpression).toBe('Record<string, unknown>');
  });

  it('should convert object with properties to interface', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
    };
    const result = jsonSchemaToTs(schema, 'Person');
    expect(result.typeExpression).toBe('Person');
    expect(result.declarations).toHaveLength(1);
    expect(result.declarations[0]).toContain('export interface Person');
    expect(result.declarations[0]).toContain('name: string');
    expect(result.declarations[0]).toContain('age?: number');
  });

  it('should mark properties with defaults as optional', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 10 },
        offset: { type: 'number' },
      },
      required: ['limit', 'offset'],
    };
    const result = jsonSchemaToTs(schema, 'Pagination');
    // limit has default, so it should be optional despite being in required
    expect(result.declarations[0]).toContain('limit?: number');
    expect(result.declarations[0]).toContain('offset: number');
  });

  it('should include JSDoc comments for descriptions', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string' },
      },
    };
    const result = jsonSchemaToTs(schema, 'SearchInput');
    expect(result.declarations[0]).toContain('* Search query string');
  });

  it('should include default values in JSDoc', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 20, description: 'Max results' },
      },
    };
    const result = jsonSchemaToTs(schema, 'Options');
    expect(result.declarations[0]).toContain('* Max results');
    expect(result.declarations[0]).toContain('@default 20');
  });

  it('should handle nested objects', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            email: { type: 'string' },
          },
          required: ['email'],
        },
      },
    };
    const result = jsonSchemaToTs(schema, 'Request');
    expect(result.typeExpression).toBe('Request');
    // Should have 2 declarations: RequestUser and Request
    expect(result.declarations).toHaveLength(2);
    expect(result.declarations[0]).toContain('export interface RequestUser');
    expect(result.declarations[1]).toContain('export interface Request');
    expect(result.declarations[1]).toContain('user?: RequestUser');
  });

  it('should handle additionalProperties with type', () => {
    const schema: JsonSchema = {
      type: 'object',
      additionalProperties: { type: 'string' },
    };
    const result = jsonSchemaToTs(schema, 'StringMap');
    expect(result.typeExpression).toBe('Record<string, string>');
  });

  it('should handle additionalProperties false with no properties', () => {
    const schema: JsonSchema = {
      type: 'object',
      additionalProperties: false,
    };
    const result = jsonSchemaToTs(schema, 'Empty');
    expect(result.typeExpression).toBe('Record<string, never>');
  });

  it('should quote property names with special characters', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        'content-type': { type: 'string' },
        'x-api-key': { type: 'string' },
      },
    };
    const result = jsonSchemaToTs(schema, 'Headers');
    expect(result.declarations[0]).toContain("'content-type'?: string");
    expect(result.declarations[0]).toContain("'x-api-key'?: string");
  });
});

describe('jsonSchemaToTs - oneOf/anyOf', () => {
  it('should convert oneOf to union type', () => {
    const schema: JsonSchema = {
      oneOf: [{ type: 'string' }, { type: 'number' }],
    };
    const result = jsonSchemaToTs(schema, 'StringOrNumber');
    expect(result.typeExpression).toBe('string | number');
  });

  it('should convert anyOf to union type', () => {
    const schema: JsonSchema = {
      anyOf: [{ type: 'string' }, { type: 'null' }],
    };
    const result = jsonSchemaToTs(schema, 'NullableString');
    expect(result.typeExpression).toBe('string | null');
  });

  it('should handle oneOf with object types', () => {
    const schema: JsonSchema = {
      oneOf: [
        {
          type: 'object',
          properties: { type: { const: 'text' }, content: { type: 'string' } },
          required: ['type', 'content'],
        },
        {
          type: 'object',
          properties: { type: { const: 'image' }, url: { type: 'string' } },
          required: ['type', 'url'],
        },
      ],
    };
    const result = jsonSchemaToTs(schema, 'Message');
    expect(result.typeExpression).toBe('MessageVariant1 | MessageVariant2');
    expect(result.declarations.length).toBeGreaterThanOrEqual(2);
  });
});

describe('jsonSchemaToTs - allOf', () => {
  it('should convert allOf to intersection type', () => {
    const schema: JsonSchema = {
      allOf: [
        { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        { type: 'object', properties: { name: { type: 'string' } } },
      ],
    };
    const result = jsonSchemaToTs(schema, 'Entity');
    expect(result.typeExpression).toBe('EntityPart1 & EntityPart2');
  });
});

describe('jsonSchemaToTs - const', () => {
  it('should convert const string', () => {
    const result = jsonSchemaToTs({ const: 'fixed' }, 'Fixed');
    expect(result.typeExpression).toBe('"fixed"');
  });

  it('should convert const number', () => {
    const result = jsonSchemaToTs({ const: 42 }, 'Answer');
    expect(result.typeExpression).toBe('42');
  });

  it('should convert const boolean', () => {
    const result = jsonSchemaToTs({ const: true }, 'Always');
    expect(result.typeExpression).toBe('true');
  });
});

describe('jsonSchemaToTs - $ref', () => {
  it('should extract type name from $ref', () => {
    const result = jsonSchemaToTs({ $ref: '#/definitions/User' }, 'Ref');
    expect(result.typeExpression).toBe('User');
  });

  it('should handle complex $ref paths', () => {
    const result = jsonSchemaToTs({ $ref: '#/components/schemas/ApiResponse' }, 'Ref');
    expect(result.typeExpression).toBe('ApiResponse');
  });
});

describe('generateToolTypes', () => {
  it('should generate input type for simple tool', () => {
    const inputSchema: JsonSchema = {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', default: 10 },
      },
      required: ['query'],
    };

    const result = generateToolTypes('search-actors', inputSchema);
    expect(result).toContain('export interface SearchActorsInput');
    expect(result).toContain('query: string');
    expect(result).toContain('limit?: number');
  });

  it('should generate both input and output types', () => {
    const inputSchema: JsonSchema = {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
    };

    const outputSchema: JsonSchema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
      },
    };

    const result = generateToolTypes('get-user', inputSchema, outputSchema);
    expect(result).toContain('export interface GetUserInput');
    expect(result).toContain('export interface GetUserOutput');
  });

  it('should handle nested objects in tool schemas', () => {
    const inputSchema: JsonSchema = {
      type: 'object',
      properties: {
        config: {
          type: 'object',
          properties: {
            timeout: { type: 'number' },
            retries: { type: 'number' },
          },
        },
      },
    };

    const result = generateToolTypes('run-task', inputSchema);
    expect(result).toContain('export interface RunTaskInputConfig');
    expect(result).toContain('export interface RunTaskInput');
  });
});

describe('edge cases', () => {
  it('should handle schema with no type (defaults to object)', () => {
    const schema: JsonSchema = {
      properties: {
        name: { type: 'string' },
      },
    };
    const result = jsonSchemaToTs(schema, 'NoType');
    expect(result.typeExpression).toBe('NoType');
    expect(result.declarations[0]).toContain('export interface NoType');
  });

  it('should handle completely empty schema', () => {
    const result = jsonSchemaToTs({}, 'Empty');
    expect(result.typeExpression).toBe('Record<string, unknown>');
  });

  it('should handle unknown type', () => {
    const result = jsonSchemaToTs({ type: 'unknown-type' as string }, 'Unknown');
    expect(result.typeExpression).toBe('unknown');
  });
});
