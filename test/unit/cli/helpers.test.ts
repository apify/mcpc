/**
 * Tests for parseHeaderFlags function
 */

import { parseHeaderFlags } from '../../../src/cli/parser.js';
import { ClientError } from '../../../src/lib/errors.js';

describe('parseHeaderFlags', () => {
  describe('valid inputs', () => {
    it('should return empty object for undefined input', () => {
      expect(parseHeaderFlags(undefined)).toEqual({});
    });

    it('should return empty object for empty array', () => {
      expect(parseHeaderFlags([])).toEqual({});
    });

    it('should parse single header', () => {
      expect(parseHeaderFlags(['Authorization: Bearer token123'])).toEqual({
        Authorization: 'Bearer token123',
      });
    });

    it('should parse multiple headers', () => {
      expect(parseHeaderFlags([
        'Authorization: Bearer token123',
        'X-Custom-Header: custom-value',
      ])).toEqual({
        Authorization: 'Bearer token123',
        'X-Custom-Header': 'custom-value',
      });
    });

    it('should trim whitespace from key and value', () => {
      expect(parseHeaderFlags(['  Content-Type  :  application/json  '])).toEqual({
        'Content-Type': 'application/json',
      });
    });

    it('should handle header with multiple colons (value contains colon)', () => {
      expect(parseHeaderFlags(['X-URL: https://example.com:8080/path'])).toEqual({
        'X-URL': 'https://example.com:8080/path',
      });
    });

    it('should handle empty value', () => {
      expect(parseHeaderFlags(['X-Empty:'])).toEqual({
        'X-Empty': '',
      });
    });

    it('should handle value with only whitespace', () => {
      expect(parseHeaderFlags(['X-Whitespace:   '])).toEqual({
        'X-Whitespace': '',
      });
    });
  });

  describe('invalid inputs', () => {
    it('should throw error for header without colon', () => {
      expect(() => parseHeaderFlags(['InvalidHeader'])).toThrow(ClientError);
      expect(() => parseHeaderFlags(['InvalidHeader'])).toThrow('Invalid header format');
    });

    it('should throw error for header with colon at start', () => {
      expect(() => parseHeaderFlags([':Value'])).toThrow(ClientError);
      expect(() => parseHeaderFlags([':Value'])).toThrow('Invalid header format');
    });

    it('should throw error for header with only colon', () => {
      expect(() => parseHeaderFlags([':'])).toThrow(ClientError);
    });
  });

  describe('edge cases', () => {
    it('should allow header key with single character', () => {
      expect(parseHeaderFlags(['X: value'])).toEqual({ X: 'value' });
    });

    it('should handle header with special characters in value', () => {
      expect(parseHeaderFlags(['X-Special: value=with&special?chars'])).toEqual({
        'X-Special': 'value=with&special?chars',
      });
    });

    it('should allow overwriting same header', () => {
      expect(parseHeaderFlags([
        'X-Header: first',
        'X-Header: second',
      ])).toEqual({
        'X-Header': 'second',
      });
    });
  });
});
