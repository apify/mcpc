/**
 * Tests for CLI output formatting
 */

import { extractSingleTextContent } from '../../src/cli/tool-result.js';

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
