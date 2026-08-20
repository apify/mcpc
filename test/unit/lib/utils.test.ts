/**
 * Unit tests for utility functions
 */

import { homedir, tmpdir } from 'os';
import { join, isAbsolute } from 'path';
import {
  expandHome,
  resolvePath,
  getMcpcHome,
  getSessionsFilePath,
  getBridgesDir,
  getShortSocketDir,
  getSocketPath,
  getLogsDir,
  isValidHttpUrl,
  normalizeServerUrl,
  getServerHost,
  isValidSessionName,
  generateSessionName,
  isValidProfileName,
  validateProfileName,
  isValidResourceUri,
  sleep,
  parseJson,
  stringifyJson,
  truncate,
  isProcessAlive,
  generateRequestId,
  fetchAllPages,
  isProtocolMismatchError,
} from '../../../src/lib/utils.js';
import { ServerError } from '../../../src/lib/errors.js';
import { DEFAULT_AUTH_PROFILE } from '../../../src/lib/auth/oauth-utils.js';

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
  const originalEnv = process.env.MCPC_HOME_DIR;

  afterEach(() => {
    // Restore original environment variable
    if (originalEnv === undefined) {
      delete process.env.MCPC_HOME_DIR;
    } else {
      process.env.MCPC_HOME_DIR = originalEnv;
    }
  });

  it('should return ~/.mcpc by default', () => {
    delete process.env.MCPC_HOME_DIR;
    const home = getMcpcHome();
    expect(home).toBe(join(homedir(), '.mcpc'));
  });

  it('should use MCPC_HOME_DIR environment variable when set', () => {
    process.env.MCPC_HOME_DIR = '/custom/mcpc/dir';
    const home = getMcpcHome();
    expect(home).toBe('/custom/mcpc/dir');
  });

  it('should expand tilde in MCPC_HOME_DIR', () => {
    process.env.MCPC_HOME_DIR = '~/custom-mcpc';
    const home = getMcpcHome();
    expect(home).toBe(join(homedir(), 'custom-mcpc'));
  });

  it('should resolve relative paths in MCPC_HOME_DIR', () => {
    process.env.MCPC_HOME_DIR = 'relative/path';
    const home = getMcpcHome();
    expect(home).toContain('relative/path');
    expect(isAbsolute(home)).toBe(true);
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

describe('getSocketPath', () => {
  const originalEnv = process.env.MCPC_HOME_DIR;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MCPC_HOME_DIR;
    } else {
      process.env.MCPC_HOME_DIR = originalEnv;
    }
  });

  // Windows uses named pipes (a different scheme); the path-length fallback is a
  // Unix-only concern, so these assertions only apply off Windows.
  const onWindows = process.platform === 'win32';

  it.skipIf(onWindows)('uses a readable socket under the bridges dir for short paths', () => {
    process.env.MCPC_HOME_DIR = '/tmp/mcpc-short';
    const socketPath = getSocketPath('my-session', 12345);
    expect(socketPath).toBe(join(getBridgesDir(), 'my-session.12345.sock'));
  });

  it.skipIf(onWindows)('relocates over-long socket paths to a short temp-dir path', () => {
    // A deep home dir pushes the natural path past the OS sun_path limit (104 bytes
    // on macOS, 108 on Linux) — exactly the case that crashed bridges on macOS CI.
    process.env.MCPC_HOME_DIR = `/tmp/mcpc-${'x'.repeat(120)}`;
    const socketPath = getSocketPath('my-session', 12345);

    // Falls back under the short temp dir, not the (over-long) bridges dir.
    expect(socketPath.startsWith(getShortSocketDir())).toBe(true);
    expect(socketPath.startsWith(getBridgesDir())).toBe(false);
    expect(socketPath.endsWith('.12345.sock')).toBe(true);

    // The fallback must itself fit within the most restrictive limit (macOS, 103).
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(103);
  });

  it.skipIf(onWindows)('keeps the fallback bounded even for a max-length session name', () => {
    process.env.MCPC_HOME_DIR = `/tmp/mcpc-${'x'.repeat(120)}`;
    const socketPath = getSocketPath('s'.repeat(64), 999999);
    expect(socketPath.startsWith(getShortSocketDir())).toBe(true);
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(103);
  });

  it.skipIf(onWindows)('derives the same path for the CLI and bridge (deterministic)', () => {
    process.env.MCPC_HOME_DIR = `/tmp/mcpc-${'x'.repeat(120)}`;
    expect(getSocketPath('sess', 4242)).toBe(getSocketPath('sess', 4242));
  });
});

describe('getShortSocketDir', () => {
  const originalEnv = process.env.MCPC_HOME_DIR;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MCPC_HOME_DIR;
    } else {
      process.env.MCPC_HOME_DIR = originalEnv;
    }
  });

  it('lives under the OS temp dir and is namespaced per home dir', () => {
    process.env.MCPC_HOME_DIR = '/tmp/home-a';
    const dirA = getShortSocketDir();
    process.env.MCPC_HOME_DIR = '/tmp/home-b';
    const dirB = getShortSocketDir();

    expect(dirA.startsWith(tmpdir())).toBe(true);
    expect(dirB.startsWith(tmpdir())).toBe(true);
    expect(dirA).not.toBe(dirB);
  });
});

describe('isValidHttpUrl', () => {
  it('should return true for valid HTTP URLs', () => {
    expect(isValidHttpUrl('http://example.com')).toBe(true);
    expect(isValidHttpUrl('http://example.com:8080')).toBe(true);
    expect(isValidHttpUrl('http://example.com/path')).toBe(true);
  });

  it('should return true for valid HTTPS URLs', () => {
    expect(isValidHttpUrl('https://example.com')).toBe(true);
    expect(isValidHttpUrl('https://example.com:443')).toBe(true);
    expect(isValidHttpUrl('https://example.com/path?query=1')).toBe(true);
  });

  it('should return false for invalid URLs', () => {
    expect(isValidHttpUrl('not a url')).toBe(false);
    expect(isValidHttpUrl('file:///path')).toBe(false);
    expect(isValidHttpUrl('ftp://example.com')).toBe(false);
    expect(isValidHttpUrl('')).toBe(false);
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

  it('should handle URL paths well', () => {
    expect(normalizeServerUrl('http://example.com?test=1')).toBe('http://example.com/?test=1');
    expect(normalizeServerUrl('http://example.com/?test=1')).toBe('http://example.com/?test=1');
    expect(normalizeServerUrl('http://example.com/?test=1#aaa')).toBe('http://example.com/?test=1');
    expect(normalizeServerUrl('https://example.com/?test=1')).toBe('https://example.com/?test=1');
  });

  it('should add https:// to URLs without scheme', () => {
    expect(normalizeServerUrl('example.com')).toBe('https://example.com');
    expect(normalizeServerUrl('mcp.apify.com')).toBe('https://mcp.apify.com');
    expect(normalizeServerUrl('api.example.com:443')).toBe('https://api.example.com'); // Default port stripped
    expect(normalizeServerUrl('api.example.com:8443')).toBe('https://api.example.com:8443'); // Non-default preserved
    expect(normalizeServerUrl('example.com/path')).toBe('https://example.com/path');
    expect(normalizeServerUrl('EXAMPLE.COM/path')).toBe('https://example.com/path');
  });

  it('should add http:// to localhost/127.0.0.1 URLs without scheme', () => {
    // localhost defaults to http:// (common for local dev/proxy servers)
    expect(normalizeServerUrl('localhost')).toBe('http://localhost');
    expect(normalizeServerUrl('localhost:8080')).toBe('http://localhost:8080');
    expect(normalizeServerUrl('localhost/path')).toBe('http://localhost/path');
    expect(normalizeServerUrl('LOCALHOST:3000')).toBe('http://localhost:3000');
    // 127.0.0.1 also defaults to http://
    expect(normalizeServerUrl('127.0.0.1')).toBe('http://127.0.0.1');
    expect(normalizeServerUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeServerUrl('127.0.0.1/mcp')).toBe('http://127.0.0.1/mcp');
  });

  it('should respect explicit scheme for localhost URLs', () => {
    // If user explicitly specifies https://, respect it
    expect(normalizeServerUrl('https://localhost')).toBe('https://localhost');
    expect(normalizeServerUrl('https://localhost:8443')).toBe('https://localhost:8443');
    expect(normalizeServerUrl('https://127.0.0.1:8443')).toBe('https://127.0.0.1:8443');
    // And http:// for remote servers
    expect(normalizeServerUrl('http://example.com')).toBe('http://example.com');
  });

  it('should throw error for URLs with invalid scheme', () => {
    expect(() => normalizeServerUrl('ftp://example.com')).toThrow('Invalid MCP server URL');
    expect(() => normalizeServerUrl('file:///path')).toThrow('Invalid MCP server URL');
    expect(() => normalizeServerUrl('ws://example.com')).toThrow('Invalid MCP server URL');
  });

  it('should throw error for invalid URLs', () => {
    expect(() => normalizeServerUrl('')).toThrow('Invalid MCP server URL');
    expect(() => normalizeServerUrl('not a url at all')).toThrow('Invalid MCP server URL');
    expect(() => normalizeServerUrl('://')).toThrow('Invalid MCP server URL');
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
    expect(normalizeServerUrl('https://user:pass@example.com/path')).toBe(
      'https://example.com/path'
    );
    expect(normalizeServerUrl('https://user:pass@example.com#hash')).toBe('https://example.com');
  });
});

describe('getServerHost', () => {
  it('should extract hostname from URL', () => {
    expect(getServerHost('https://example.com')).toBe('example.com');
    expect(getServerHost('https://mcp.apify.com')).toBe('mcp.apify.com');
    expect(getServerHost('http://example.com')).toBe('example.com');
    expect(getServerHost('example.com')).toBe('example.com');
  });

  it('should include non-standard ports', () => {
    expect(getServerHost('https://example.com:8443')).toBe('example.com:8443');
    expect(getServerHost('http://localhost:8080')).toBe('localhost:8080');
    expect(getServerHost('example.com:3000')).toBe('example.com:3000');
  });

  it('should strip standard ports', () => {
    expect(getServerHost('https://example.com:443')).toBe('example.com');
    expect(getServerHost('http://example.com:80')).toBe('example.com');
  });

  it('should normalize hostname to lowercase', () => {
    expect(getServerHost('https://EXAMPLE.COM')).toBe('example.com');
    expect(getServerHost('HTTPS://Example.COM')).toBe('example.com');
    expect(getServerHost('MCP.APIFY.COM')).toBe('mcp.apify.com');
    expect(getServerHost('Localhost:8080')).toBe('localhost:8080');
  });

  it('should strip path, query, and hash from URL', () => {
    expect(getServerHost('https://example.com/path')).toBe('example.com');
    expect(getServerHost('https://example.com/path?query=1')).toBe('example.com');
    expect(getServerHost('https://example.com:8443/path')).toBe('example.com:8443');
    expect(getServerHost('https://example.com#hash')).toBe('example.com');
    expect(getServerHost('https://user:pass@example.com/path')).toBe('example.com');
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
    expect(isValidSessionName('test')).toBe(false); // missing @
    expect(isValidSessionName('test session')).toBe(false); // space
    expect(isValidSessionName('test.session')).toBe(false); // dot
    expect(isValidSessionName('test@session')).toBe(false); // @ in wrong place
    expect(isValidSessionName('test/session')).toBe(false); // /
    expect(isValidSessionName('@test/session')).toBe(false); // /
    expect(isValidSessionName('@test.session')).toBe(false); // .
    expect(isValidSessionName('@test session')).toBe(false); // space
    expect(isValidSessionName('@test ')).toBe(false); // space
    expect(isValidSessionName(' @test')).toBe(false); // space
    expect(isValidSessionName('@')).toBe(false); // @ alone
    expect(isValidSessionName('@' + 'a'.repeat(65))).toBe(false); // too long
  });
});

describe('generateSessionName', () => {
  describe('URL targets', () => {
    it('should extract brand from mcp.*.com hostnames', () => {
      expect(generateSessionName({ type: 'url', url: 'mcp.apify.com' })).toBe('@apify');
      expect(generateSessionName({ type: 'url', url: 'mcp.example.com' })).toBe('@example');
    });

    it('should extract brand from api.*.com hostnames', () => {
      expect(generateSessionName({ type: 'url', url: 'api.example.com' })).toBe('@example');
    });

    it('should extract brand from www.*.com hostnames', () => {
      expect(generateSessionName({ type: 'url', url: 'www.example.com' })).toBe('@example');
    });

    it('should handle multi-part TLDs (co.uk, etc.)', () => {
      expect(generateSessionName({ type: 'url', url: 'mcp.example.co.uk' })).toBe('@example');
    });

    it('should handle deep subdomains by stripping only one prefix', () => {
      expect(generateSessionName({ type: 'url', url: 'api.deep-research.anthropic.com' })).toBe(
        '@deep-research'
      );
    });

    it('should use the hostname directly when no common prefix', () => {
      expect(generateSessionName({ type: 'url', url: 'simple.com' })).toBe('@simple');
    });

    it('should handle single-label hostnames', () => {
      expect(generateSessionName({ type: 'url', url: 'localhost' })).toBe('@localhost');
    });

    it('should append non-standard port', () => {
      expect(generateSessionName({ type: 'url', url: 'localhost:3000' })).toBe('@localhost-3000');
      expect(generateSessionName({ type: 'url', url: '127.0.0.1:8080' })).toBe('@127-0-0-1-8080');
    });

    it('should not append standard ports', () => {
      expect(generateSessionName({ type: 'url', url: 'https://example.com:443' })).toBe('@example');
      expect(generateSessionName({ type: 'url', url: 'http://localhost:80' })).toBe('@localhost');
    });

    it('should handle IP addresses by replacing dots with hyphens', () => {
      expect(generateSessionName({ type: 'url', url: '127.0.0.1' })).toBe('@127-0-0-1');
      expect(generateSessionName({ type: 'url', url: '192.168.1.100' })).toBe('@192-168-1-100');
    });

    it('should handle full URLs with scheme', () => {
      expect(generateSessionName({ type: 'url', url: 'https://mcp.apify.com' })).toBe('@apify');
      expect(generateSessionName({ type: 'url', url: 'http://localhost:3000' })).toBe(
        '@localhost-3000'
      );
    });

    it('should lowercase the result', () => {
      expect(generateSessionName({ type: 'url', url: 'MCP.APIFY.COM' })).toBe('@apify');
    });

    it('should produce valid session names', () => {
      const urls = [
        'mcp.apify.com',
        'mcp.example.co.uk',
        'localhost:3000',
        '127.0.0.1:8080',
        'api.deep-research.anthropic.com',
        'simple.com',
      ];
      for (const url of urls) {
        const name = generateSessionName({ type: 'url', url });
        expect(isValidSessionName(name)).toBe(true);
      }
    });
  });

  describe('config entry targets', () => {
    it('should use the entry name directly', () => {
      expect(
        generateSessionName({ type: 'config', file: '~/.vscode/mcp.json', entry: 'filesystem' })
      ).toBe('@filesystem');
    });

    it('should sanitize special characters', () => {
      expect(
        generateSessionName({ type: 'config', file: '~/.vscode/mcp.json', entry: 'my server' })
      ).toBe('@my-server');
      expect(
        generateSessionName({
          type: 'config',
          file: '~/.vscode/mcp.json',
          entry: 'my.server.name',
        })
      ).toBe('@my-server-name');
    });

    it('should produce valid session names', () => {
      const entries = ['filesystem', 'my-server', 'puppeteer', 'test_server'];
      for (const entry of entries) {
        const name = generateSessionName({
          type: 'config',
          file: '~/.vscode/mcp.json',
          entry,
        });
        expect(isValidSessionName(name)).toBe(true);
      }
    });
  });
});

describe('isValidProfileName', () => {
  it('should return true for valid profile names', () => {
    expect(isValidProfileName(DEFAULT_AUTH_PROFILE)).toBe(true);
    expect(isValidProfileName('default')).toBe(true);
    expect(isValidProfileName('personal')).toBe(true);
    expect(isValidProfileName('work')).toBe(true);
    expect(isValidProfileName('test-123')).toBe(true);
    expect(isValidProfileName('test_profile')).toBe(true);
    expect(isValidProfileName('abc123XYZ')).toBe(true);
    expect(isValidProfileName('a')).toBe(true); // single char
    expect(isValidProfileName('a'.repeat(64))).toBe(true); // max length
  });

  it('should return false for invalid profile names', () => {
    expect(isValidProfileName('')).toBe(false); // empty
    expect(isValidProfileName('@test')).toBe(false); // starts with @
    expect(isValidProfileName('test profile')).toBe(false); // space
    expect(isValidProfileName('test.profile')).toBe(false); // dot
    expect(isValidProfileName('test@profile')).toBe(false); // @
    expect(isValidProfileName('test/profile')).toBe(false); // /
    expect(isValidProfileName('test profile')).toBe(false); // space
    expect(isValidProfileName('test ')).toBe(false); // trailing space
    expect(isValidProfileName(' test')).toBe(false); // leading space
    expect(isValidProfileName('a'.repeat(65))).toBe(false); // too long
  });
});

describe('validateProfileName', () => {
  it('should not throw for valid profile names', () => {
    expect(() => validateProfileName('default')).not.toThrow();
    expect(() => validateProfileName('personal')).not.toThrow();
  });

  it('should throw for invalid profile names', () => {
    expect(() => validateProfileName('')).toThrow('Invalid profile name');
    expect(() => validateProfileName('@test')).toThrow('Invalid profile name');
    expect(() => validateProfileName('test profile')).toThrow('Invalid profile name');
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
    // No room for the suffix plus any text, so cut without one rather than overflow
    expect(truncate('abcd', 3)).toBe('abc');
    expect(truncate('abcd', 0)).toBe('');
  });

  it('should count the suffix towards maxLength', () => {
    expect(truncate('hello world', 11, ' [trimmed]')).toBe('hello world');
    expect(truncate('hello world, this is long', 20, ' [trimmed]')).toBe('hello worl [trimmed]');

    // A suffix that leaves no room for text is dropped, keeping the result within maxLength
    const result = truncate('hello world', 10, ' [trimmed]');
    expect(result).toBe('hello worl');
    expect(result.length).toBe(10);
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

describe('fetchAllPages', () => {
  it('collects items across all pages', async () => {
    const pages: Record<string, { items: number[]; nextCursor?: string }> = {
      start: { items: [1, 2], nextCursor: 'p2' },
      p2: { items: [3], nextCursor: 'p3' },
      p3: { items: [4, 5] },
    };
    const result = await fetchAllPages(
      async (cursor) => pages[cursor ?? 'start'],
      (page) => page.items
    );
    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns a single page when there is no nextCursor', async () => {
    const result = await fetchAllPages(
      async () => ({ items: ['only'] }),
      (page) => page.items
    );
    expect(result).toEqual(['only']);
  });

  it('aborts with ServerError when the server repeats a cursor', async () => {
    // A misbehaving server that always hands back the same cursor would
    // otherwise loop forever with unbounded memory growth.
    await expect(
      fetchAllPages(
        async () => ({ items: [1], nextCursor: 'same' }),
        (page) => page.items
      )
    ).rejects.toThrow(ServerError);
  });

  it('aborts with ServerError on a cursor cycle', async () => {
    const pages: Record<string, { items: number[]; nextCursor?: string }> = {
      start: { items: [1], nextCursor: 'a' },
      a: { items: [2], nextCursor: 'b' },
      b: { items: [3], nextCursor: 'a' }, // cycle back to a
    };
    await expect(
      fetchAllPages(
        async (cursor) => pages[cursor ?? 'start'],
        (page) => page.items
      )
    ).rejects.toThrow(/pagination cursor/);
  });
});

describe('isProtocolMismatchError', () => {
  it('matches the envelope rejection a 2026-07-28 server answers a bare modern header with', () => {
    // Exactly what a resumed session used to hit on every reconnect (#374).
    expect(
      isProtocolMismatchError(
        'Ping failed: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32602,' +
          '"message":"Invalid params: the MCP-Protocol-Version header names protocol revision ' +
          '2026-07-28, but the request is missing the required per-request envelope key(s): _meta"}}'
      )
    ).toBe(true);
  });

  it('matches the HeaderMismatch and UnsupportedProtocolVersion codes', () => {
    expect(isProtocolMismatchError('{"error":{"code":-32020,"message":"header mismatch"}}')).toBe(
      true
    );
    expect(isProtocolMismatchError('{"error":{"code":-32022,"message":"nope"}}')).toBe(true);
  });

  it("matches the SDK's own version verdicts", () => {
    expect(isProtocolMismatchError("Server's protocol version is not supported: 2027-01-01")).toBe(
      true
    );
    expect(
      isProtocolMismatchError(
        'connect({ prior }) with a modern verdict requires a 2026-07-28+ mutual protocol version'
      )
    ).toBe(true);
  });

  it('does not match unrelated failures', () => {
    // These have their own recovery paths — resumption must survive them.
    expect(isProtocolMismatchError('Session expired: session id not found')).toBe(false);
    expect(isProtocolMismatchError('HTTP 401 invalid_token')).toBe(false);
    expect(isProtocolMismatchError('fetch failed: ECONNREFUSED')).toBe(false);
    expect(isProtocolMismatchError('{"error":{"code":-32602,"message":"Invalid params"}}')).toBe(
      false
    );
  });
});
