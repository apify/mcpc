/**
 * Tests for argument parsing utilities
 */

import { parseCommandArgs, loadArgsFromFile } from '../../src/cli/parser.js';
import { ClientError } from '../../src/lib/errors.js';
import { join } from 'path';

describe('parseCommandArgs', () => {
  describe('empty or undefined input', () => {
    it('should return empty object for undefined args', () => {
      const result = parseCommandArgs(undefined);
      expect(result).toEqual({});
    });

    it('should return empty object for empty array', () => {
      const result = parseCommandArgs([]);
      expect(result).toEqual({});
    });
  });

  describe('inline JSON format', () => {
    it('should parse inline JSON object', () => {
      const result = parseCommandArgs(['{"query":"hello","limit":10}']);
      expect(result).toEqual({ query: 'hello', limit: 10 });
    });

    it('should parse inline JSON array', () => {
      const result = parseCommandArgs(['[1,2,3]']);
      expect(result).toEqual([1, 2, 3]);
    });

    it('should parse nested JSON object', () => {
      const result = parseCommandArgs(['{"config":{"key":"value"},"items":[1,2,3]}']);
      expect(result).toEqual({ config: { key: 'value' }, items: [1, 2, 3] });
    });

    it('should throw error when multiple arguments provided with inline JSON', () => {
      expect(() => {
        parseCommandArgs(['{"query":"hello"}', 'extra']);
      }).toThrow(ClientError);
      expect(() => {
        parseCommandArgs(['{"query":"hello"}', 'extra']);
      }).toThrow('When using inline JSON, only one argument is allowed');
    });

    it('should throw error for invalid JSON', () => {
      expect(() => {
        parseCommandArgs(['{invalid json}']);
      }).toThrow(ClientError);
      expect(() => {
        parseCommandArgs(['{invalid json}']);
      }).toThrow('Invalid JSON');
    });

    it('should throw error for strings not starting with { or [', () => {
      // Strings that don't start with { or [ are treated as invalid key=value format
      expect(() => {
        parseCommandArgs(['"just a string"']);
      }).toThrow(ClientError);
      expect(() => {
        parseCommandArgs(['"just a string"']);
      }).toThrow('Invalid argument format');
    });

    it('should throw error for literal null not starting with { or [', () => {
      // "null" without quotes is treated as invalid key=value format
      expect(() => {
        parseCommandArgs(['null']);
      }).toThrow(ClientError);
      expect(() => {
        parseCommandArgs(['null']);
      }).toThrow('Invalid argument format');
    });
  });

  describe('key=value format (string values)', () => {
    it('should parse single key=value pair', () => {
      const result = parseCommandArgs(['query=hello']);
      expect(result).toEqual({ query: 'hello' });
    });

    it('should parse multiple key=value pairs', () => {
      const result = parseCommandArgs(['query=hello', 'name=world']);
      expect(result).toEqual({ query: 'hello', name: 'world' });
    });

    it('should handle values with spaces', () => {
      const result = parseCommandArgs(['query=hello world']);
      expect(result).toEqual({ query: 'hello world' });
    });

    it('should handle empty values', () => {
      const result = parseCommandArgs(['query=']);
      expect(result).toEqual({ query: '' });
    });

    it('should handle values with = sign', () => {
      // When splitting by = with limit 2, only the first = is used as separator
      const result = parseCommandArgs(['equation=x=y']);
      expect(result).toEqual({ equation: 'x=y' });
    });

    it('should throw error for key without value', () => {
      expect(() => {
        parseCommandArgs(['query']);
      }).toThrow(ClientError);
      expect(() => {
        parseCommandArgs(['query']);
      }).toThrow('Invalid argument format: query. Use key=value, key:=json, or inline JSON');
    });

    it('should throw error for empty key', () => {
      expect(() => {
        parseCommandArgs(['=value']);
      }).toThrow(ClientError);
      expect(() => {
        parseCommandArgs(['=value']);
      }).toThrow('Invalid argument format: =value. Use key=value or key:=json');
    });
  });

  describe('key:=json format (typed values)', () => {
    it('should parse number value', () => {
      const result = parseCommandArgs(['limit:=10']);
      expect(result).toEqual({ limit: 10 });
    });

    it('should parse boolean true', () => {
      const result = parseCommandArgs(['enabled:=true']);
      expect(result).toEqual({ enabled: true });
    });

    it('should parse boolean false', () => {
      const result = parseCommandArgs(['enabled:=false']);
      expect(result).toEqual({ enabled: false });
    });

    it('should parse null', () => {
      const result = parseCommandArgs(['value:=null']);
      expect(result).toEqual({ value: null });
    });

    it('should parse JSON object', () => {
      const result = parseCommandArgs(['config:={"key":"value"}']);
      expect(result).toEqual({ config: { key: 'value' } });
    });

    it('should parse JSON array', () => {
      const result = parseCommandArgs(['items:=[1,2,3]']);
      expect(result).toEqual({ items: [1, 2, 3] });
    });

    it('should throw error for invalid JSON value', () => {
      expect(() => {
        parseCommandArgs(['limit:=invalid']);
      }).toThrow(ClientError);
      expect(() => {
        parseCommandArgs(['limit:=invalid']);
      }).toThrow('Invalid JSON value for limit');
    });

    it('should throw error for empty key', () => {
      expect(() => {
        parseCommandArgs([':=123']);
      }).toThrow(ClientError);
      expect(() => {
        parseCommandArgs([':=123']);
      }).toThrow('Invalid argument format: :=123. Use key=value or key:=json');
    });
  });

  describe('mixed formats', () => {
    it('should parse mixed key=value and key:=json pairs', () => {
      const result = parseCommandArgs(['query=hello', 'limit:=10', 'enabled:=true']);
      expect(result).toEqual({ query: 'hello', limit: 10, enabled: true });
    });

    it('should handle complex mixed arguments', () => {
      const result = parseCommandArgs([
        'name=test',
        'count:=42',
        'active:=true',
        'tags:=["a","b"]',
        'config:={"x":1}',
      ]);
      expect(result).toEqual({
        name: 'test',
        count: 42,
        active: true,
        tags: ['a', 'b'],
        config: { x: 1 },
      });
    });
  });

  describe('edge cases', () => {
    it('should handle keys with numbers', () => {
      const result = parseCommandArgs(['key1=value1', 'key2:=123']);
      expect(result).toEqual({ key1: 'value1', key2: 123 });
    });

    it('should handle keys with underscores', () => {
      const result = parseCommandArgs(['some_key=value']);
      expect(result).toEqual({ some_key: 'value' });
    });

    it('should handle keys with hyphens', () => {
      const result = parseCommandArgs(['some-key=value']);
      expect(result).toEqual({ 'some-key': 'value' });
    });

    it('should allow overwriting keys', () => {
      const result = parseCommandArgs(['key=first', 'key=second']);
      expect(result).toEqual({ key: 'second' });
    });

    it('should parse string that looks like JSON number', () => {
      const result = parseCommandArgs(['id=123']);
      expect(result).toEqual({ id: '123' });
      expect(typeof result.id).toBe('string');
    });

    it('should parse := before = in precedence', () => {
      // := is checked first, so "expr=x:=5" is parsed as key="expr=x", value=5 (JSON)
      const result = parseCommandArgs(['expr=x:=5']);
      expect(result).toEqual({ 'expr=x': 5 });
    });
  });
});

describe('loadArgsFromFile', () => {
  const testDataDir = join(__dirname, '..', 'data');

  it('should load arguments from valid JSON file', () => {
    const filePath = join(testDataDir, 'tool-args.json');
    const result = loadArgsFromFile(filePath);
    expect(result).toEqual({
      query: 'hello world',
      limit: 10,
      enabled: true,
      config: {
        timeout: 30,
      },
    });
  });

  it('should resolve relative paths', () => {
    const filePath = 'test/data/tool-args.json';
    const result = loadArgsFromFile(filePath);
    expect(result).toEqual({
      query: 'hello world',
      limit: 10,
      enabled: true,
      config: {
        timeout: 30,
      },
    });
  });

  it('should throw error for non-existent file', () => {
    const filePath = join(testDataDir, 'non-existent.json');
    expect(() => {
      loadArgsFromFile(filePath);
    }).toThrow(ClientError);
    expect(() => {
      loadArgsFromFile(filePath);
    }).toThrow('Arguments file not found');
  });

  it('should throw error for array JSON', () => {
    const filePath = join(testDataDir, 'tool-args-invalid.json');
    expect(() => {
      loadArgsFromFile(filePath);
    }).toThrow(ClientError);
    expect(() => {
      loadArgsFromFile(filePath);
    }).toThrow('Arguments file must contain a JSON object');
  });

  it('should throw error for malformed JSON', () => {
    const filePath = join(testDataDir, 'tool-args-malformed.json');
    expect(() => {
      loadArgsFromFile(filePath);
    }).toThrow(ClientError);
    expect(() => {
      loadArgsFromFile(filePath);
    }).toThrow('Invalid JSON in arguments file');
  });

  it('should expand tilde in file path', () => {
    // Create a file in home directory for testing
    const homeFile = join(process.env.HOME || '~', '.mcpc-test-args.json');
    const fs = require('fs');
    fs.writeFileSync(homeFile, JSON.stringify({ test: 'value' }));

    try {
      const result = loadArgsFromFile('~/.mcpc-test-args.json');
      expect(result).toEqual({ test: 'value' });
    } finally {
      // Clean up
      fs.unlinkSync(homeFile);
    }
  });
});
