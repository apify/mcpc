/**
 * Unit tests for utility functions
 */

import { homedir } from 'os';
import { join } from 'path';
import {
  expandHome,
  resolvePath,
  getMcpcHome,
  getSessionsFilePath,
  getBridgesDir,
  getLogsDir,
  getHistoryFilePath,
  isValidUrl,
  normalizeServerUrl,
  getAuthServerKey,
  isValidSessionName,
  isValidResourceUri,
  sleep,
  parseJson,
  stringifyJson,
  truncate,
  isProcessAlive,
  generateRequestId,
} from '../../src/lib/utils';

describe('expandHome', () => {
  it('should expand ~ to home directory', () => {
    const expanded = expandHome('~/test');
    expect(expanded).toBe(join(homedir(), 'test'));
  });

  it('should expand ~ alone to home directory', () => {
    const expanded = expandHome('~');
    expect(expanded).toBe(homedir());
  });

  it('should not modify paths without ~', () => {
    const path = '/absolute/path';
    expect(expandHome(path)).toBe(path);
  });
});

describe('resolvePath', () => {
  it('should resolve relative paths', () => {
    const resolved = resolvePath('test/file.txt');
    expect(resolved).toContain('test/file.txt');
  });

  it('should expand home directory', () => {
    const resolved = resolvePath('~/test');
    expect(resolved).toContain(homedir());
  });

  it('should not modify absolute paths', () => {
    const resolved = resolvePath('/absolute/path');
    expect(resolved).toBe('/absolute/path');
  });
});

describe('getMcpcHome', () => {
  it('should return ~/.mcpc', () => {
    const home = getMcpcHome();
    expect(home).toBe(join(homedir(), '.mcpc'));
  });
});

describe('getSessionsFilePath', () => {
  it('should return ~/.mcpc/sessions.json', () => {
    const path = getSessionsFilePath();
    expect(path).toBe(join(homedir(), '.mcpc', 'sessions.json'));
  });
});

describe('getBridgesDir', () => {
  it('should return ~/.mcpc/bridges/', () => {
    const dir = getBridgesDir();
    expect(dir).toBe(join(homedir(), '.mcpc', 'bridges'));
  });
});

describe('getLogsDir', () => {
  it('should return ~/.mcpc/logs/', () => {
    const dir = getLogsDir();
    expect(dir).toBe(join(homedir(), '.mcpc', 'logs'));
  });
});

describe('getHistoryFilePath', () => {
  it('should return ~/.mcpc/history', () => {
    const path = getHistoryFilePath();
    expect(path).toBe(join(homedir(), '.mcpc', 'history'));
  });
});

describe('isValidUrl', () => {
  it('should return true for valid HTTP URLs', () => {
    expect(isValidUrl('http://example.com')).toBe(true);
    expect(isValidUrl('http://example.com:8080')).toBe(true);
    expect(isValidUrl('http://example.com/path')).toBe(true);
  });

  it('should return true for valid HTTPS URLs', () => {
    expect(isValidUrl('https://example.com')).toBe(true);
    expect(isValidUrl('https://example.com:443')).toBe(true);
    expect(isValidUrl('https://example.com/path?query=1')).toBe(true);
  });

  it('should return false for invalid URLs', () => {
    expect(isValidUrl('not a url')).toBe(false);
    expect(isValidUrl('file:///path')).toBe(false);
    expect(isValidUrl('ftp://example.com')).toBe(false);
    expect(isValidUrl('')).toBe(false);
  });
});

describe('normalizeServerUrl', () => {
  it('should accept URLs with https:// scheme', () => {
    expect(normalizeServerUrl('https://example.com')).toBe('https://example.com');
    expect(normalizeServerUrl('https://example.com/')).toBe('https://example.com'); // remove trailing slash
    expect(normalizeServerUrl('https://mcp.apify.com')).toBe('https://mcp.apify.com');
    expect(normalizeServerUrl('https://example.com:443')).toBe('https://example.com'); // Default port stripped
    expect(normalizeServerUrl('https://example.com:8443')).toBe('https://example.com:8443'); // Non-default preserved
    expect(normalizeServerUrl('https://example.com/path')).toBe('https://example.com/path');
    expect(normalizeServerUrl('https://EXAMPLE.COM/path')).toBe('https://example.com/path');
  });

  it('should accept URLs with http:// scheme', () => {
    expect(normalizeServerUrl('http://localhost')).toBe('http://localhost');
    expect(normalizeServerUrl('http://localhost/')).toBe('http://localhost'); // remove trailing slash
    expect(normalizeServerUrl('http://localhost:8080')).toBe('http://localhost:8080');
    expect(normalizeServerUrl('http://example.com')).toBe('http://example.com');
    expect(normalizeServerUrl('http://EXAMPLE.COM')).toBe('http://example.com');
  });

  it('should add https:// to URLs without scheme', () => {
    expect(normalizeServerUrl('example.com')).toBe('https://example.com');
    expect(normalizeServerUrl('mcp.apify.com')).toBe('https://mcp.apify.com');
    expect(normalizeServerUrl('api.example.com:443')).toBe('https://api.example.com'); // Default port stripped
    expect(normalizeServerUrl('api.example.com:8443')).toBe('https://api.example.com:8443'); // Non-default preserved
    expect(normalizeServerUrl('example.com/path')).toBe('https://example.com/path');
    expect(normalizeServerUrl('EXAMPLE.COM/path')).toBe('https://example.com/path');
  });

  it('should throw error for URLs with invalid scheme', () => {
    expect(() => normalizeServerUrl('ftp://example.com')).toThrow('Invalid URL');
    expect(() => normalizeServerUrl('file:///path')).toThrow('Invalid URL');
    expect(() => normalizeServerUrl('ws://example.com')).toThrow('Invalid URL');
  });

  it('should throw error for invalid URLs', () => {
    expect(() => normalizeServerUrl('')).toThrow('Invalid URL');
    expect(() => normalizeServerUrl('not a url at all')).toThrow('Invalid URL');
    expect(() => normalizeServerUrl('://')).toThrow('Invalid URL');
  });

  it('should remove hash fragments', () => {
    expect(normalizeServerUrl('https://example.com#hash')).toBe('https://example.com');
    expect(normalizeServerUrl('https://example.com/#hash')).toBe('https://example.com');
    expect(normalizeServerUrl('https://example.com/path#section')).toBe('https://example.com/path');
    expect(normalizeServerUrl('example.com#hash')).toBe('https://example.com');
    expect(normalizeServerUrl('http://localhost:8080#anchor')).toBe('http://localhost:8080');
  });

  it('should remove username and password', () => {
    expect(normalizeServerUrl('https://user:pass@example.com')).toBe('https://example.com');
    expect(normalizeServerUrl('https://admin@example.com')).toBe('https://example.com');
    expect(normalizeServerUrl('http://user:pass@localhost:8080')).toBe('http://localhost:8080');
    expect(normalizeServerUrl('https://user:pass@example.com/path')).toBe('https://example.com/path');
    expect(normalizeServerUrl('https://user:pass@example.com#hash')).toBe('https://example.com');
  });
});

describe('getAuthServerKey', () => {
  it('should extract hostname from URL', () => {
    expect(getAuthServerKey('https://example.com')).toBe('example.com');
    expect(getAuthServerKey('https://mcp.apify.com')).toBe('mcp.apify.com');
    expect(getAuthServerKey('http://example.com')).toBe('example.com');
    expect(getAuthServerKey('example.com')).toBe('example.com');
  });

  it('should ignore port numbers', () => {
    expect(getAuthServerKey('https://example.com:8443')).toBe('example.com');
    expect(getAuthServerKey('http://localhost:8080')).toBe('localhost');
    expect(getAuthServerKey('example.com:3000')).toBe('example.com');
    expect(getAuthServerKey('https://example.com:443')).toBe('example.com');
    expect(getAuthServerKey('http://example.com:80')).toBe('example.com');
  });

  it('should normalize hostname to lowercase', () => {
    expect(getAuthServerKey('https://EXAMPLE.COM')).toBe('example.com');
    expect(getAuthServerKey('HTTPS://Example.COM')).toBe('example.com');
    expect(getAuthServerKey('MCP.APIFY.COM')).toBe('mcp.apify.com');
    expect(getAuthServerKey('Localhost:8080')).toBe('localhost');
  });

  it('should strip path, query, and hash from URL', () => {
    expect(getAuthServerKey('https://example.com/path')).toBe('example.com');
    expect(getAuthServerKey('https://example.com/path?query=1')).toBe('example.com');
    expect(getAuthServerKey('https://example.com:8443/path')).toBe('example.com');
    expect(getAuthServerKey('https://example.com#hash')).toBe('example.com');
    expect(getAuthServerKey('https://user:pass@example.com/path')).toBe('example.com');
  });
});

describe('isValidSessionName', () => {
  it('should return true for valid session names', () => {
    expect(isValidSessionName('@test')).toBe(true);
    expect(isValidSessionName('@test-123')).toBe(true);
    expect(isValidSessionName('@test_session')).toBe(true);
    expect(isValidSessionName('@abc123XYZ')).toBe(true);
  });

  it('should return false for invalid session names', () => {
    expect(isValidSessionName('')).toBe(false);
    expect(isValidSessionName('test')).toBe(false); // space
    expect(isValidSessionName('test session')).toBe(false); // space
    expect(isValidSessionName('test.session')).toBe(false); // dot
    expect(isValidSessionName('test@session')).toBe(false); // @
    expect(isValidSessionName('test/session')).toBe(false); // /
    expect(isValidSessionName('@test/session')).toBe(false); // /
    expect(isValidSessionName('@test.session')).toBe(false); // .
    expect(isValidSessionName('@test session')).toBe(false); // space
    expect(isValidSessionName('@test ')).toBe(false); // space
    expect(isValidSessionName(' @test')).toBe(false); // space
    expect(isValidSessionName('a'.repeat(65))).toBe(false); // too long
  });
});

describe('isValidResourceUri', () => {
  it('should return true for valid URIs', () => {
    expect(isValidResourceUri('file:///path/to/file')).toBe(true);
    expect(isValidResourceUri('https://example.com')).toBe(true);
    expect(isValidResourceUri('memory://test')).toBe(true);
  });

  it('should return false for invalid URIs', () => {
    expect(isValidResourceUri('not a uri')).toBe(false);
    expect(isValidResourceUri('')).toBe(false);
  });
});

describe('sleep', () => {
  it('should delay for specified milliseconds', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // Allow some margin
  });
});

describe('parseJson', () => {
  it('should parse valid JSON', () => {
    const result = parseJson('{"foo":"bar"}');
    expect(result).toEqual({ foo: 'bar' });
  });

  it('should throw on invalid JSON', () => {
    expect(() => parseJson('not json')).toThrow('Invalid JSON');
  });
});

describe('stringifyJson', () => {
  it('should stringify without pretty printing', () => {
    const result = stringifyJson({ foo: 'bar' }, false);
    expect(result).toBe('{"foo":"bar"}');
  });

  it('should stringify with pretty printing', () => {
    const result = stringifyJson({ foo: 'bar' }, true);
    expect(result).toBe('{\n  "foo": "bar"\n}');
  });
});

describe('truncate', () => {
  it('should not truncate short strings', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('should truncate long strings', () => {
    expect(truncate('hello world', 8)).toBe('hello...');
  });

  it('should handle edge cases', () => {
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('abcd', 3)).toBe('...');
  });
});

describe('isProcessAlive', () => {
  it('should return true for current process', () => {
    const alive = isProcessAlive(process.pid);
    expect(alive).toBe(true);
  });

  it('should return false for non-existent process', () => {
    // Use a very high PID that unlikely exists
    const alive = isProcessAlive(999999);
    expect(alive).toBe(false);
  });
});

describe('generateRequestId', () => {
  it('should generate unique request IDs', () => {
    const id1 = generateRequestId();
    const id2 = generateRequestId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^req_\d+_\d+$/);
    expect(id2).toMatch(/^req_\d+_\d+$/);
  });
});
