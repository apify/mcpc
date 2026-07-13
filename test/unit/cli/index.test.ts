/**
 * Unit tests for CLI argument parsing functions
 */

import { extractOptions, parseServerArg, hasSubcommand } from '../../../src/cli/parser.js';

// args format mirrors process.argv: [node, script, ...actual_args]
const A = (...args: string[]) => ['node', 'script', ...args];

describe('hasSubcommand', () => {
  it('returns true when a subcommand is present', () => {
    expect(hasSubcommand(A('tools-list'))).toBe(true);
  });

  it('returns true when subcommand follows options', () => {
    expect(hasSubcommand(A('--json', 'tools-list'))).toBe(true);
  });

  it('returns true when subcommand follows an option with value', () => {
    expect(hasSubcommand(A('--timeout', '30', 'ping'))).toBe(true);
  });

  it('returns false when only options are present', () => {
    expect(hasSubcommand(A('--json', '--verbose'))).toBe(false);
  });

  it('returns false for empty args', () => {
    expect(hasSubcommand(A())).toBe(false);
  });

  it('does not treat option values as subcommands', () => {
    expect(hasSubcommand(A('--timeout', '30'))).toBe(false);
  });
});

describe('parseServerArg', () => {
  it('should parse a bare domain as URL', () => {
    const result = parseServerArg('mcp.apify.com');
    expect(result).toEqual({ type: 'url', url: 'mcp.apify.com' });

    const result2 = parseServerArg('example.com');
    expect(result2).toEqual({ type: 'url', url: 'example.com' });

    const result3 = parseServerArg('example');
    expect(result3).toEqual({ type: 'url', url: 'example' });
  });

  it('should parse a full URL as URL', () => {
    const result = parseServerArg('https://mcp.apify.com');
    expect(result).toEqual({ type: 'url', url: 'https://mcp.apify.com' });

    const result2 = parseServerArg('http://mcp.apify.com');
    expect(result2).toEqual({ type: 'url', url: 'http://mcp.apify.com' });

    const result3 = parseServerArg('http://mcp.apify.com:8000');
    expect(result3).toEqual({ type: 'url', url: 'http://mcp.apify.com:8000' });
  });

  it('should parse a URL with path (no colon-entry) as URL', () => {
    const result = parseServerArg('https://mcp.apify.com/v1');
    expect(result).toEqual({ type: 'url', url: 'https://mcp.apify.com/v1' });

    const result2 = parseServerArg('mcp.apify.com/v1');
    expect(result2).toEqual({ type: 'url', url: 'mcp.apify.com/v1' });

    const result3 = parseServerArg('mcp.apify.com:8000/v1');
    expect(result3).toEqual({ type: 'url', url: 'mcp.apify.com:8000/v1' });
  });

  it('should parse ~/.vscode/mcp.json:filesystem as config', () => {
    const result = parseServerArg('~/.vscode/mcp.json:filesystem');
    expect(result).toEqual({ type: 'config', file: '~/.vscode/mcp.json', entry: 'filesystem' });
  });

  it('should parse ./mcp.json:server as config', () => {
    const result = parseServerArg('./mcp.json:server');
    expect(result).toEqual({ type: 'config', file: './mcp.json', entry: 'server' });
  });

  it('should parse /absolute/path.json:entry as config', () => {
    const result = parseServerArg('/absolute/path.json:entry');
    expect(result).toEqual({ type: 'config', file: '/absolute/path.json', entry: 'entry' });
  });

  it('should parse .json extension as config', () => {
    const result = parseServerArg('./config.json:myserver');
    expect(result).toEqual({ type: 'config', file: './config.json', entry: 'myserver' });

    const result2 = parseServerArg('config.json:myserver');
    expect(result2).toEqual({ type: 'config', file: 'config.json', entry: 'myserver' });
  });

  it('should parse .yaml extension as config', () => {
    const result = parseServerArg('./config.yaml:myserver');
    expect(result).toEqual({ type: 'config', file: './config.yaml', entry: 'myserver' });

    const result2 = parseServerArg('config.yaml:myserver');
    expect(result2).toEqual({ type: 'config', file: 'config.yaml', entry: 'myserver' });
  });

  it('should parse .yml extension as config', () => {
    const result = parseServerArg('./config.yml:myserver');
    expect(result).toEqual({ type: 'config', file: './config.yml', entry: 'myserver' });

    const result2 = parseServerArg('config.yml:myserver');
    expect(result2).toEqual({ type: 'config', file: 'config.yml', entry: 'myserver' });

    const result3 = parseServerArg('../config.yml:myserver');
    expect(result3).toEqual({ type: 'config', file: '../config.yml', entry: 'myserver' });
  });

  it('should NOT parse hostname:port as config', () => {
    // 127.0.0.1:8080 — does not look like a file path
    const result = parseServerArg('127.0.0.1:8080');
    expect(result).toEqual({ type: 'url', url: '127.0.0.1:8080' });

    const result2 = parseServerArg('mcp.example.com:8080');
    expect(result2).toEqual({ type: 'url', url: 'mcp.example.com:8080' });
  });

  it('should NOT parse URL with :// as config', () => {
    const result = parseServerArg('https://example.com');
    expect(result).toEqual({ type: 'url', url: 'https://example.com' });
  });

  it('should return null for colon-only or leading-colon input', () => {
    expect(parseServerArg(':')).toBeNull();
    expect(parseServerArg(':entry')).toBeNull();
  });

  it('should return null for trailing-colon input', () => {
    expect(parseServerArg('file:')).toBeNull();
  });

  it('should return null for hostname:non-numeric-port (not a valid URL or file path)', () => {
    expect(parseServerArg('example.com:foo')).toBeNull();
    expect(parseServerArg('myhost:notaport')).toBeNull();
  });

  it('should return null for https:// URL with invalid port', () => {
    expect(parseServerArg('https://mcp.apify.com:invalid')).toBeNull();
    expect(parseServerArg('http://example.com:badport')).toBeNull();
  });

  it('should return null for other invalid full-URL syntax', () => {
    expect(parseServerArg('https://host:badport/path')).toBeNull();
  });

  it('should parse Windows drive-letter config paths correctly', () => {
    const result = parseServerArg('C:\\Users\\me\\mcp.json:filesystem');
    expect(result).toEqual({
      type: 'config',
      file: 'C:\\Users\\me\\mcp.json',
      entry: 'filesystem',
    });

    const result2 = parseServerArg('D:/projects/config.yaml:myserver');
    expect(result2).toEqual({ type: 'config', file: 'D:/projects/config.yaml', entry: 'myserver' });
  });

  it('should parse bare config file path (no :entry) as config-file', () => {
    expect(parseServerArg('~/.vscode/mcp.json')).toEqual({
      type: 'config-file',
      file: '~/.vscode/mcp.json',
    });

    expect(parseServerArg('./mcp.json')).toEqual({
      type: 'config-file',
      file: './mcp.json',
    });

    expect(parseServerArg('/absolute/path/config.json')).toEqual({
      type: 'config-file',
      file: '/absolute/path/config.json',
    });

    expect(parseServerArg('../config.yaml')).toEqual({
      type: 'config-file',
      file: '../config.yaml',
    });

    expect(parseServerArg('config.json')).toEqual({
      type: 'config-file',
      file: 'config.json',
    });

    expect(parseServerArg('config.yml')).toEqual({
      type: 'config-file',
      file: 'config.yml',
    });
  });

  it('should parse Windows bare config file path as config-file', () => {
    expect(parseServerArg('C:\\Users\\me\\mcp.json')).toEqual({
      type: 'config-file',
      file: 'C:\\Users\\me\\mcp.json',
    });

    expect(parseServerArg('D:/projects/config.yaml')).toEqual({
      type: 'config-file',
      file: 'D:/projects/config.yaml',
    });
  });

  it('should NOT parse bare hostname as config-file', () => {
    // These should still be URLs, not config files
    expect(parseServerArg('example.com')).toEqual({ type: 'url', url: 'example.com' });
    expect(parseServerArg('mcp.apify.com')).toEqual({ type: 'url', url: 'mcp.apify.com' });
  });

  it('should parse relative config path with :entry as config', () => {
    // Regression: `docs/examples/mcp-config.json:fs` was parsed as URL because
    // `https://docs/examples/mcp-config.json:fs` parses as a URL with host=docs.
    expect(parseServerArg('docs/examples/mcp-config.json:fs')).toEqual({
      type: 'config',
      file: 'docs/examples/mcp-config.json',
      entry: 'fs',
    });

    expect(parseServerArg('subdir/config.yaml:server')).toEqual({
      type: 'config',
      file: 'subdir/config.yaml',
      entry: 'server',
    });
  });

  it('should return null for empty or whitespace-only input', () => {
    expect(parseServerArg('')).toBeNull();
    expect(parseServerArg(' ')).toBeNull();
    expect(parseServerArg('   ')).toBeNull();
  });

  it('should parse IPv6 URLs', () => {
    expect(parseServerArg('http://[::1]:8080/mcp')).toEqual({
      type: 'url',
      url: 'http://[::1]:8080/mcp',
    });
    expect(parseServerArg('https://[2001:db8::1]:8443')).toEqual({
      type: 'url',
      url: 'https://[2001:db8::1]:8443',
    });
    // Bare bracketed IPv6 with port (no scheme) — treated as URL via https:// prefix
    expect(parseServerArg('[::1]:8080')).toEqual({ type: 'url', url: '[::1]:8080' });
  });

  it('should parse localhost variants as URL', () => {
    expect(parseServerArg('localhost')).toEqual({ type: 'url', url: 'localhost' });
    expect(parseServerArg('localhost:3000')).toEqual({ type: 'url', url: 'localhost:3000' });
    expect(parseServerArg('localhost:3000/mcp')).toEqual({
      type: 'url',
      url: 'localhost:3000/mcp',
    });
    expect(parseServerArg('http://localhost')).toEqual({ type: 'url', url: 'http://localhost' });
    expect(parseServerArg('127.0.0.1')).toEqual({ type: 'url', url: '127.0.0.1' });
  });

  it('should parse URLs with query strings and fragments as URL', () => {
    expect(parseServerArg('mcp.apify.com?query=foo')).toEqual({
      type: 'url',
      url: 'mcp.apify.com?query=foo',
    });
    expect(parseServerArg('mcp.apify.com#frag')).toEqual({
      type: 'url',
      url: 'mcp.apify.com#frag',
    });
    expect(parseServerArg('https://mcp.apify.com/path?q=1&r=2#frag')).toEqual({
      type: 'url',
      url: 'https://mcp.apify.com/path?q=1&r=2#frag',
    });
  });

  it('should parse URLs with userinfo as URL', () => {
    expect(parseServerArg('https://user:pass@mcp.example.com')).toEqual({
      type: 'url',
      url: 'https://user:pass@mcp.example.com',
    });
    // Bare user:pass@host — ambiguous but currently routed through the https:// probe
    expect(parseServerArg('user:pass@example.com')).toEqual({
      type: 'url',
      url: 'user:pass@example.com',
    });
  });

  it('should parse URLs with various schemes', () => {
    expect(parseServerArg('ws://example.com')).toEqual({ type: 'url', url: 'ws://example.com' });
    expect(parseServerArg('wss://example.com/mcp')).toEqual({
      type: 'url',
      url: 'wss://example.com/mcp',
    });
    expect(parseServerArg('ftp://example.com/file')).toEqual({
      type: 'url',
      url: 'ftp://example.com/file',
    });
    expect(parseServerArg('git+ssh://example.com/repo')).toEqual({
      type: 'url',
      url: 'git+ssh://example.com/repo',
    });
  });

  it('should parse URLs with mixed-case schemes', () => {
    expect(parseServerArg('HTTPS://example.com')).toEqual({
      type: 'url',
      url: 'HTTPS://example.com',
    });
    expect(parseServerArg('Http://Example.Com')).toEqual({
      type: 'url',
      url: 'Http://Example.Com',
    });
  });

  it('should return null for ://-containing arg with empty host (e.g. file:///)', () => {
    // `file:///path` has a valid scheme but no host; since we only support HTTP transports,
    // step 1b rejects any `://` arg that fails URL-with-host validation.
    expect(parseServerArg('file:///path/to/config')).toBeNull();
    expect(parseServerArg('https://')).toBeNull();
  });

  it('should parse uppercase config extensions as config', () => {
    expect(parseServerArg('./config.JSON:entry')).toEqual({
      type: 'config',
      file: './config.JSON',
      entry: 'entry',
    });
    expect(parseServerArg('./config.YAML:entry')).toEqual({
      type: 'config',
      file: './config.YAML',
      entry: 'entry',
    });
    expect(parseServerArg('./Config.Yml:entry')).toEqual({
      type: 'config',
      file: './Config.Yml',
      entry: 'entry',
    });
    expect(parseServerArg('CONFIG.JSON:entry')).toEqual({
      type: 'config',
      file: 'CONFIG.JSON',
      entry: 'entry',
    });
    expect(parseServerArg('CONFIG.JSON')).toEqual({ type: 'config-file', file: 'CONFIG.JSON' });
  });

  it('should split on the first colon (entry may contain further colons)', () => {
    expect(parseServerArg('./config.json:entry:subentry')).toEqual({
      type: 'config',
      file: './config.json',
      entry: 'entry:subentry',
    });
    expect(parseServerArg('/abs/path.json:a:b:c')).toEqual({
      type: 'config',
      file: '/abs/path.json',
      entry: 'a:b:c',
    });
  });

  it('should parse entry names with numbers, dashes, and underscores', () => {
    expect(parseServerArg('./config.json:my-entry_v2')).toEqual({
      type: 'config',
      file: './config.json',
      entry: 'my-entry_v2',
    });
    // Entry name that looks like a port number — still config because left side is a file path
    expect(parseServerArg('./config.json:8080')).toEqual({
      type: 'config',
      file: './config.json',
      entry: '8080',
    });
    expect(parseServerArg('./config.json:123')).toEqual({
      type: 'config',
      file: './config.json',
      entry: '123',
    });
  });

  it('should parse paths with spaces as config', () => {
    expect(parseServerArg('/path with spaces/config.json:entry')).toEqual({
      type: 'config',
      file: '/path with spaces/config.json',
      entry: 'entry',
    });
    expect(parseServerArg('/path with spaces/config.json')).toEqual({
      type: 'config-file',
      file: '/path with spaces/config.json',
    });
  });

  it('should parse relative config path without extension + :entry as config', () => {
    // The left side contains a `/` so it counts as a file path even without .json/.yaml/.yml
    expect(parseServerArg('./no_ext_file:entry')).toEqual({
      type: 'config',
      file: './no_ext_file',
      entry: 'entry',
    });
    expect(parseServerArg('subdir/no_ext:entry')).toEqual({
      type: 'config',
      file: 'subdir/no_ext',
      entry: 'entry',
    });
  });

  it('should parse URL with port 0 or high port as URL', () => {
    expect(parseServerArg('example.com:0')).toEqual({ type: 'url', url: 'example.com:0' });
    expect(parseServerArg('example.com:65535')).toEqual({
      type: 'url',
      url: 'example.com:65535',
    });
  });

  it('should parse URL with trailing slash and FQDN dot', () => {
    expect(parseServerArg('mcp.apify.com/')).toEqual({ type: 'url', url: 'mcp.apify.com/' });
    expect(parseServerArg('https://example.com/')).toEqual({
      type: 'url',
      url: 'https://example.com/',
    });
    expect(parseServerArg('app.example.com.:8080')).toEqual({
      type: 'url',
      url: 'app.example.com.:8080',
    });
  });

  it('should return null for trailing colon on hostname (dangling port)', () => {
    expect(parseServerArg('config.yml:')).toBeNull();
    expect(parseServerArg('mcp.apify.com:')).toBeNull();
  });

  it('should return null for bare IPv6 without brackets or scheme', () => {
    // `::1` has a leading colon which fails the `colonIndex > 0` check and is not a valid URL.
    expect(parseServerArg('::1')).toBeNull();
  });

  it('should return null for single-token arg that parses as URL with empty host', () => {
    // `A:foo` parses with scheme=a, path=foo, no host. Also fails `https://A:foo` (bad port).
    expect(parseServerArg('A:foo')).toBeNull();
    expect(parseServerArg('foo:bar:baz')).toBeNull();
  });

  it('should parse deeply-nested subdomains as URL', () => {
    expect(parseServerArg('a.b.c.d.e.example.com')).toEqual({
      type: 'url',
      url: 'a.b.c.d.e.example.com',
    });
  });

  it('should parse path-like arg with colon-in-path as config when left side has a slash', () => {
    // `host/path:v1` — left side has a `/` so it triggers the config branch. Users wanting
    // a URL with `:` in the path should pass a full `https://` URL.
    expect(parseServerArg('mcp.apify.com/api:v1')).toEqual({
      type: 'config',
      file: 'mcp.apify.com/api',
      entry: 'v1',
    });
    // Fully-qualified URL form bypasses the config heuristic.
    expect(parseServerArg('https://mcp.apify.com/api:v1')).toEqual({
      type: 'url',
      url: 'https://mcp.apify.com/api:v1',
    });
  });

  it('should parse relative path with .. (parent directory) as config', () => {
    expect(parseServerArg('../../config.json:entry')).toEqual({
      type: 'config',
      file: '../../config.json',
      entry: 'entry',
    });
    expect(parseServerArg('../sibling/mcp.json:fs')).toEqual({
      type: 'config',
      file: '../sibling/mcp.json',
      entry: 'fs',
    });
  });

  it('should parse Windows drive-letter bare extension without :entry as config-file', () => {
    expect(parseServerArg('C:\\configs\\mcp.json')).toEqual({
      type: 'config-file',
      file: 'C:\\configs\\mcp.json',
    });
    expect(parseServerArg('D:/configs/mcp.yml')).toEqual({
      type: 'config-file',
      file: 'D:/configs/mcp.yml',
    });
  });
});

describe('extractOptions', () => {
  it('should extract boolean flags', () => {
    const result = extractOptions(['--json', '--verbose']);
    expect(result).toEqual({ json: true, verbose: true });
  });

  it('should extract --json short form (-j)', () => {
    const result = extractOptions(['-j']);
    expect(result).toEqual({ json: true, verbose: false });
  });

  it('should not extract --header (connect-specific option)', () => {
    const result = extractOptions(['--header', 'Auth: Bearer token', '--header', 'X-Key: value']);
    expect(result).toEqual({
      json: false,
      verbose: false,
    });
  });

  it('should not extract -H short form (connect-specific option)', () => {
    const result = extractOptions(['-H', 'Auth: token', '-H', 'X-Key: value']);
    expect(result).toEqual({
      json: false,
      verbose: false,
    });
  });

  it('should extract --timeout', () => {
    const result = extractOptions(['--timeout', '120']);
    expect(result).toEqual({ json: false, verbose: false, timeoutSecs: 120 });
  });

  it('should extract all global options together', () => {
    const result = extractOptions(['--json', '--verbose', '--timeout', '60']);
    expect(result).toEqual({
      json: true,
      verbose: true,
      timeoutSecs: 60,
    });
  });

  it('should handle empty args', () => {
    const result = extractOptions([]);
    expect(result).toEqual({ json: false, verbose: false });
  });

  it('should handle timeout at end of args', () => {
    const result = extractOptions(['--json', '--timeout']);
    expect(result).toEqual({ json: true, verbose: false });
  });

  it('should parse timeout as integer', () => {
    const result = extractOptions(['--timeout', '300']);
    expect(result).toEqual({ json: false, verbose: false, timeoutSecs: 300 });
  });

  it('should handle NaN timeout gracefully', () => {
    const result = extractOptions(['--timeout', 'invalid']);
    expect(result.timeoutSecs).toBeNaN();
  });
});
