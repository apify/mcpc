/**
 * Tests for argument parsing utilities
 */

import {
  parseCommandArgs,
  getVerboseFromEnv,
  getJsonFromEnv,
  validateOptions,
  validateArgValues,
  optionTakesValue,
  hasSubcommand,
  suggestCommand,
  normalizeSlashCommand,
  normalizeSlashCommandArgs,
  preProcessSkillArgv,
  preProcessX402Argv,
} from '../../../src/cli/parser.js';
import { ClientError } from '../../../src/lib/errors.js';

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
      // Strings that don't start with { or [ are treated as invalid key:=value format
      expect(() => {
        parseCommandArgs(['"just a string"']);
      }).toThrow(ClientError);
      expect(() => {
        parseCommandArgs(['"just a string"']);
      }).toThrow('Invalid argument format');
    });

    it('should throw error for literal null not starting with { or [', () => {
      // "null" without quotes is treated as invalid key:=value format
      expect(() => {
        parseCommandArgs(['null']);
      }).toThrow(ClientError);
      expect(() => {
        parseCommandArgs(['null']);
      }).toThrow('Invalid argument format');
    });
  });

  describe('key:=value format (auto-parsed values)', () => {
    it('should parse number value', () => {
      const result = parseCommandArgs(['limit:=10']);
      expect(result).toEqual({ limit: 10 });
    });

    it('should keep integers beyond MAX_SAFE_INTEGER as strings (no precision loss)', () => {
      // e.g. snowflake IDs — JSON.parse would silently round these
      const result = parseCommandArgs(['id:=12345678901234567890']);
      expect(result).toEqual({ id: '12345678901234567890' });
    });

    it('should keep large negative integers as strings', () => {
      const result = parseCommandArgs(['id:=-12345678901234567890']);
      expect(result).toEqual({ id: '-12345678901234567890' });
    });

    it('should still parse safe 16+ digit-looking numbers within range', () => {
      // 16 digits but within MAX_SAFE_INTEGER (9007199254740991)
      const result = parseCommandArgs(['n:=9007199254740991']);
      expect(result).toEqual({ n: 9007199254740991 });
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

    it('should parse string value (non-JSON)', () => {
      // Auto-parsing: if not valid JSON, treat as string
      const result = parseCommandArgs(['query:=hello']);
      expect(result).toEqual({ query: 'hello' });
    });

    it('should parse quoted string as string', () => {
      const result = parseCommandArgs(['query:="hello world"']);
      expect(result).toEqual({ query: 'hello world' });
    });

    it('should parse numeric string as string when quoted', () => {
      const result = parseCommandArgs(['id:="123"']);
      expect(result).toEqual({ id: '123' });
    });

    it('should throw error for empty key', () => {
      expect(() => {
        parseCommandArgs([':=123']);
      }).toThrow(ClientError);
      expect(() => {
        parseCommandArgs([':=123']);
      }).toThrow('Invalid argument');
    });
  });

  describe('only key:=value syntax supported', () => {
    it('should throw error for key=value format', () => {
      expect(() => {
        parseCommandArgs(['query=hello']);
      }).toThrow(ClientError);
      expect(() => {
        parseCommandArgs(['query=hello']);
      }).toThrow('Invalid argument format');
    });

    it('should throw error for bare key without value', () => {
      expect(() => {
        parseCommandArgs(['query']);
      }).toThrow(ClientError);
      expect(() => {
        parseCommandArgs(['query']);
      }).toThrow('Invalid argument format');
    });
  });

  describe('multiple key:=value pairs', () => {
    it('should parse multiple pairs', () => {
      const result = parseCommandArgs(['query:=hello', 'limit:=10', 'enabled:=true']);
      expect(result).toEqual({ query: 'hello', limit: 10, enabled: true });
    });

    it('should handle complex mixed arguments', () => {
      const result = parseCommandArgs([
        'name:=test',
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
      const result = parseCommandArgs(['key1:=value1', 'key2:=123']);
      expect(result).toEqual({ key1: 'value1', key2: 123 });
    });

    it('should handle keys with underscores', () => {
      const result = parseCommandArgs(['some_key:=value']);
      expect(result).toEqual({ some_key: 'value' });
    });

    it('should handle keys with hyphens', () => {
      const result = parseCommandArgs(['some-key:=value']);
      expect(result).toEqual({ 'some-key': 'value' });
    });

    it('should allow overwriting keys', () => {
      const result = parseCommandArgs(['key:=first', 'key:=second']);
      expect(result).toEqual({ key: 'second' });
    });

    it('should handle values with := in them', () => {
      // Only first := is used as separator
      const result = parseCommandArgs(['expr:=a:=b']);
      expect(result).toEqual({ expr: 'a:=b' });
    });

    it('should handle empty string value', () => {
      const result = parseCommandArgs(['key:=""']);
      expect(result).toEqual({ key: '' });
    });

    it('should treat unquoted empty value as empty string', () => {
      const result = parseCommandArgs(['key:=']);
      expect(result).toEqual({ key: '' });
    });
  });
});

describe('getVerboseFromEnv', () => {
  const originalEnv = process.env.MCPC_VERBOSE;

  afterEach(() => {
    // Restore original environment variable
    if (originalEnv === undefined) {
      delete process.env.MCPC_VERBOSE;
    } else {
      process.env.MCPC_VERBOSE = originalEnv;
    }
  });

  it('should return false when not set', () => {
    delete process.env.MCPC_VERBOSE;
    expect(getVerboseFromEnv()).toBe(false);
  });

  it('should return true when set to "1"', () => {
    process.env.MCPC_VERBOSE = '1';
    expect(getVerboseFromEnv()).toBe(true);
  });

  it('should return true when set to "true"', () => {
    process.env.MCPC_VERBOSE = 'true';
    expect(getVerboseFromEnv()).toBe(true);
  });

  it('should return true when set to "yes"', () => {
    process.env.MCPC_VERBOSE = 'yes';
    expect(getVerboseFromEnv()).toBe(true);
  });

  it('should be case-insensitive', () => {
    process.env.MCPC_VERBOSE = 'TRUE';
    expect(getVerboseFromEnv()).toBe(true);
    process.env.MCPC_VERBOSE = 'Yes';
    expect(getVerboseFromEnv()).toBe(true);
  });

  it('should trim whitespace', () => {
    process.env.MCPC_VERBOSE = '  true  ';
    expect(getVerboseFromEnv()).toBe(true);
  });

  it('should return false for other values', () => {
    process.env.MCPC_VERBOSE = '0';
    expect(getVerboseFromEnv()).toBe(false);
    process.env.MCPC_VERBOSE = 'false';
    expect(getVerboseFromEnv()).toBe(false);
    process.env.MCPC_VERBOSE = 'no';
    expect(getVerboseFromEnv()).toBe(false);
    process.env.MCPC_VERBOSE = 'random';
    expect(getVerboseFromEnv()).toBe(false);
  });
});

describe('getJsonFromEnv', () => {
  const originalEnv = process.env.MCPC_JSON;

  afterEach(() => {
    // Restore original environment variable
    if (originalEnv === undefined) {
      delete process.env.MCPC_JSON;
    } else {
      process.env.MCPC_JSON = originalEnv;
    }
  });

  it('should return false when not set', () => {
    delete process.env.MCPC_JSON;
    expect(getJsonFromEnv()).toBe(false);
  });

  it('should return true when set to "1"', () => {
    process.env.MCPC_JSON = '1';
    expect(getJsonFromEnv()).toBe(true);
  });

  it('should return true when set to "true"', () => {
    process.env.MCPC_JSON = 'true';
    expect(getJsonFromEnv()).toBe(true);
  });

  it('should return true when set to "yes"', () => {
    process.env.MCPC_JSON = 'yes';
    expect(getJsonFromEnv()).toBe(true);
  });

  it('should be case-insensitive', () => {
    process.env.MCPC_JSON = 'TRUE';
    expect(getJsonFromEnv()).toBe(true);
  });

  it('should return false for other values', () => {
    process.env.MCPC_JSON = '0';
    expect(getJsonFromEnv()).toBe(false);
    process.env.MCPC_JSON = 'false';
    expect(getJsonFromEnv()).toBe(false);
  });
});

describe('optionTakesValue', () => {
  it('should return true for global options that take values', () => {
    expect(optionTakesValue('-H')).toBe(true);
    expect(optionTakesValue('--header')).toBe(true);
    expect(optionTakesValue('--timeout')).toBe(true);
    expect(optionTakesValue('--profile')).toBe(true);
  });

  it('should return true for subcommand-specific options that take values', () => {
    expect(optionTakesValue('--schema')).toBe(true);
    expect(optionTakesValue('--schema-mode')).toBe(true);
    expect(optionTakesValue('--proxy')).toBe(true);
    expect(optionTakesValue('--proxy-bearer-token')).toBe(true);
    expect(optionTakesValue('--scope')).toBe(true);
    expect(optionTakesValue('--client-id')).toBe(true);
    expect(optionTakesValue('--client-secret')).toBe(true);
    expect(optionTakesValue('-o')).toBe(true);
    expect(optionTakesValue('--output')).toBe(true);
    expect(optionTakesValue('--amount')).toBe(true);
    expect(optionTakesValue('--expiry')).toBe(true);
  });

  it('should return false for boolean flags', () => {
    expect(optionTakesValue('--verbose')).toBe(false);
    expect(optionTakesValue('--json')).toBe(false);
    expect(optionTakesValue('-j')).toBe(false);
    expect(optionTakesValue('-v')).toBe(false);
    expect(optionTakesValue('--help')).toBe(false);
    expect(optionTakesValue('-h')).toBe(false);
  });

  it('should handle --option=value syntax by extracting option name', () => {
    expect(optionTakesValue('--timeout=30')).toBe(true);
    expect(optionTakesValue('--header=Authorization')).toBe(true);
    expect(optionTakesValue('--verbose=true')).toBe(false);
  });

  it('should return false for unknown options', () => {
    expect(optionTakesValue('--unknown')).toBe(false);
    expect(optionTakesValue('--foo')).toBe(false);
  });
});

describe('hasSubcommand', () => {
  it('should return false for empty or option-only args', () => {
    // args[0] = node, args[1] = script, so effective args start at index 2
    expect(hasSubcommand(['node', 'mcpc'])).toBe(false);
    expect(hasSubcommand(['node', 'mcpc', '--verbose'])).toBe(false);
    expect(hasSubcommand(['node', 'mcpc', '--json', '--verbose'])).toBe(false);
  });

  it('should return true when a non-option arg is present', () => {
    expect(hasSubcommand(['node', 'mcpc', 'connect'])).toBe(true);
    expect(hasSubcommand(['node', 'mcpc', '@session'])).toBe(true);
    expect(hasSubcommand(['node', 'mcpc', '--json', 'connect'])).toBe(true);
  });

  it('should skip values of options that take values', () => {
    // --header takes a value; 'connect' is not the value of --header if placed correctly
    expect(hasSubcommand(['node', 'mcpc', '--header', 'Auth: Bearer x', 'connect'])).toBe(true);
    // --timeout takes a value; '30' should be skipped, not treated as a subcommand
    expect(hasSubcommand(['node', 'mcpc', '--timeout', '30'])).toBe(false);
  });

  it('should skip values of subcommand-specific options that take values', () => {
    // --proxy takes a value; its value should be skipped during scanning
    expect(hasSubcommand(['node', 'mcpc', '--proxy', '8080'])).toBe(false);
    expect(hasSubcommand(['node', 'mcpc', '--scope', 'read'])).toBe(false);
    expect(hasSubcommand(['node', 'mcpc', '-o', 'out.txt'])).toBe(false);
  });

  it('should handle --option=value syntax without skipping next arg', () => {
    expect(hasSubcommand(['node', 'mcpc', '--timeout=30', 'connect'])).toBe(true);
    // The value is embedded in the option, so 'connect' is the subcommand
    expect(hasSubcommand(['node', 'mcpc', '--timeout=30'])).toBe(false);
  });
});

describe('validateOptions', () => {
  it('should not throw for known global options', () => {
    expect(() => validateOptions(['--verbose', '--json'])).not.toThrow();
    expect(() => validateOptions(['--json', '--verbose'])).not.toThrow();
    expect(() => validateOptions(['-j'])).not.toThrow();
  });

  it('should not throw for known value options with separate values', () => {
    expect(() => validateOptions(['--timeout', '30'])).not.toThrow();
    expect(() => validateOptions(['--profile', 'personal'])).not.toThrow();
  });

  it('should not throw for subcommand-specific options after a command token', () => {
    // --scope appears after 'login' command token — must not be rejected
    expect(() => validateOptions(['login', 'mcp.apify.com', '--scope', 'read'])).not.toThrow();
    // --amount, --expiry for x402 sign
    expect(() => validateOptions(['x402', 'sign', 'data', '--amount', '1.0'])).not.toThrow();
    // -o/--output for resources-read
    expect(() =>
      validateOptions(['@session', 'resources-read', 'uri', '-o', 'out.txt'])
    ).not.toThrow();
  });

  it('should not throw for unknown options that appear after @session (non-option token)', () => {
    expect(() =>
      validateOptions(['--json', '@mysession', '--unknown-subcommand-flag'])
    ).not.toThrow();
  });

  it('should throw for unknown options that appear before any command token', () => {
    // No command token at all
    expect(() => validateOptions(['--unknown'])).toThrow(ClientError);
    expect(() => validateOptions(['--unknown'])).toThrow('Unknown option: --unknown');
    // Unknown option before a command token
    expect(() => validateOptions(['--bad-flag', 'login'])).toThrow(ClientError);
    expect(() => validateOptions(['--bad-flag', 'login'])).toThrow('Unknown option: --bad-flag');
  });

  it('should reject subcommand-specific options when used as global options', () => {
    // These options are valid only after a command token; before that they are unknown
    expect(() => validateOptions(['--full'])).toThrow(ClientError);
    expect(() => validateOptions(['--full'])).toThrow('Unknown option: --full');
    expect(() => validateOptions(['--x402'])).toThrow(ClientError);
    expect(() => validateOptions(['--x402'])).toThrow('Unknown option: --x402');
    expect(() => validateOptions(['--scope', 'read'])).toThrow(ClientError);
    expect(() => validateOptions(['--scope', 'read'])).toThrow('Unknown option: --scope');
    expect(() => validateOptions(['--proxy', '8080'])).toThrow(ClientError);
    expect(() => validateOptions(['--proxy', '8080'])).toThrow('Unknown option: --proxy');
    expect(() => validateOptions(['-o', 'out.txt'])).toThrow(ClientError);
    expect(() => validateOptions(['-o', 'out.txt'])).toThrow('Unknown option: -o');
    expect(() => validateOptions(['--output', 'out.txt'])).toThrow(ClientError);
    expect(() => validateOptions(['--client-id', 'abc'])).toThrow(ClientError);
    // --header is connect-specific, not global
    expect(() => validateOptions(['--header', 'Authorization: Bearer token'])).toThrow(ClientError);
    expect(() => validateOptions(['-H', 'Authorization: Bearer token'])).toThrow(ClientError);
  });

  it('should accept subcommand-specific options after a command token', () => {
    // Same options that were rejected above should pass after a command token
    expect(() => validateOptions(['connect', 'srv', '--full'])).not.toThrow();
    expect(() => validateOptions(['connect', 'srv', '--x402'])).not.toThrow();
    expect(() => validateOptions(['login', 'srv', '--scope', 'read'])).not.toThrow();
    expect(() => validateOptions(['connect', 'srv', '--proxy', '8080'])).not.toThrow();
    expect(() => validateOptions(['@s', 'resources-read', 'uri', '-o', 'out.txt'])).not.toThrow();
    expect(() =>
      validateOptions(['login', 'srv', '--client-id', 'abc', '--client-secret', 'xyz'])
    ).not.toThrow();
    // --header is accepted after connect command token
    expect(() =>
      validateOptions(['connect', 'srv', '@s', '--header', 'Authorization: Bearer token'])
    ).not.toThrow();
    expect(() =>
      validateOptions(['connect', 'srv', '@s', '-H', 'Authorization: Bearer token'])
    ).not.toThrow();
  });

  it('should accept empty args array', () => {
    expect(() => validateOptions([])).not.toThrow();
  });

  it('should skip the value of a global option that takes a value', () => {
    // --timeout takes a value, so the next token should be skipped during validation
    expect(() => validateOptions(['--timeout', '30', 'connect'])).not.toThrow();
    // --profile takes a value, so the next token should be skipped
    expect(() => validateOptions(['--profile', 'myprofile', 'connect'])).not.toThrow();
  });

  it('should handle --option=value syntax', () => {
    expect(() => validateOptions(['--timeout=30'])).not.toThrow();
  });
});

describe('validateArgValues', () => {
  it('should throw for invalid --timeout value before command token', () => {
    expect(() => validateArgValues(['--timeout', 'notanumber'])).toThrow(ClientError);
    expect(() => validateArgValues(['--timeout', 'notanumber'])).toThrow('Invalid --timeout value');
  });

  it('should not validate --timeout after command token', () => {
    expect(() =>
      validateArgValues(['connect', 'example.com', '--timeout', 'notanumber'])
    ).not.toThrow();
  });
});

describe('suggestCommand', () => {
  const commands = [
    'tools-list',
    'tools-get',
    'tools-call',
    'resources-list',
    'resources-read',
    'skills-list',
    'skills-get',
    'prompts-list',
    'prompts-get',
    'connect',
    'login',
    'help',
  ];

  it('suggests the closest match for reversed command names', () => {
    expect(suggestCommand('list-tools', commands)).toBe('tools-list');
    expect(suggestCommand('list-resources', commands)).toBe('resources-list');
    expect(suggestCommand('list-prompts', commands)).toBe('prompts-list');
    expect(suggestCommand('list-skills', commands)).toBe('skills-list');
  });

  it('suggests list command for bare prefix (tools, resources, prompts, skills)', () => {
    expect(suggestCommand('tools', commands)).toBe('tools-list');
    expect(suggestCommand('resources', commands)).toBe('resources-list');
    expect(suggestCommand('prompts', commands)).toBe('prompts-list');
    expect(suggestCommand('skills', commands)).toBe('skills-list');
    // Case-insensitive
    expect(suggestCommand('TOOLS', commands)).toBe('tools-list');
    expect(suggestCommand('Resources', commands)).toBe('resources-list');
    expect(suggestCommand('Skills', commands)).toBe('skills-list');
  });

  it('suggests the closest match for typos', () => {
    expect(suggestCommand('tools-lst', commands)).toBe('tools-list');
    expect(suggestCommand('conect', commands)).toBe('connect');
    expect(suggestCommand('loign', commands)).toBe('login');
  });

  it('suggests closest match for short inputs within maxDistance', () => {
    // "call" → "help" has distance 3, which equals maxDistance
    expect(suggestCommand('call', commands)).toBe('help');
    // Too distant inputs return undefined
    expect(suggestCommand('xyz', commands)).toBeUndefined();
  });

  it('is case-insensitive', () => {
    expect(suggestCommand('TOOLS-LIST', commands)).toBe('tools-list');
    expect(suggestCommand('Tools-Call', commands)).toBe('tools-call');
  });

  it('returns undefined when no match is close enough', () => {
    expect(suggestCommand('completely-unrelated', commands)).toBeUndefined();
    expect(suggestCommand('xyzzy', commands)).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    expect(suggestCommand('', commands)).toBeUndefined();
  });

  it('respects custom maxDistance', () => {
    // With very low maxDistance, even close matches are rejected
    expect(suggestCommand('tools-lst', commands, 0)).toBeUndefined();
    // With higher maxDistance, more distant matches are accepted
    expect(suggestCommand('tools-lst', commands, 1)).toBe('tools-list');
  });
});

describe('normalizeSlashCommand', () => {
  it('returns the input unchanged when there is no slash', () => {
    expect(normalizeSlashCommand('tools-list')).toBe('tools-list');
    expect(normalizeSlashCommand('connect')).toBe('connect');
  });

  it('converts simple slash method names to hyphenated form', () => {
    expect(normalizeSlashCommand('tools/list')).toBe('tools-list');
    expect(normalizeSlashCommand('tools/call')).toBe('tools-call');
    expect(normalizeSlashCommand('resources/read')).toBe('resources-read');
    expect(normalizeSlashCommand('prompts/get')).toBe('prompts-get');
    expect(normalizeSlashCommand('server/discover')).toBe('server-discover');
  });

  it('converts multi-segment slash method names', () => {
    expect(normalizeSlashCommand('resources/templates/list')).toBe('resources-templates-list');
  });

  it('splits camelCase segments into kebab-case', () => {
    expect(normalizeSlashCommand('logging/setLevel')).toBe('logging-set-level');
  });
});

describe('normalizeSlashCommandArgs', () => {
  const commands = ['tools-list', 'tools-call', 'resources-read', 'logging-set-level'];

  it('rewrites the first positional token when it maps to a known command', () => {
    expect(normalizeSlashCommandArgs(['node', 'script', 'tools/list'], commands, 2)).toEqual([
      'node',
      'script',
      'tools-list',
    ]);
  });

  it('skips leading global options (and their values) before the command token', () => {
    expect(
      normalizeSlashCommandArgs(['node', 'script', '--json', 'tools/call', 'my-tool'], commands, 2)
    ).toEqual(['node', 'script', '--json', 'tools-call', 'my-tool']);
    expect(
      normalizeSlashCommandArgs(
        ['node', 'script', '--timeout', '30', 'logging/setLevel', 'debug'],
        commands,
        2
      )
    ).toEqual(['node', 'script', '--timeout', '30', 'logging-set-level', 'debug']);
  });

  it('leaves the args unchanged when the slash token has no known mapping', () => {
    const args = ['node', 'script', 'foo/bar'];
    expect(normalizeSlashCommandArgs(args, commands, 2)).toBe(args);
  });

  it('leaves already-hyphenated commands unchanged', () => {
    const args = ['node', 'script', 'tools-list'];
    expect(normalizeSlashCommandArgs(args, commands, 2)).toBe(args);
  });

  it('does not touch positional args after the command token even if they contain a slash', () => {
    expect(
      normalizeSlashCommandArgs(['node', 'script', 'resources-read', 'file:///tmp/x'], commands, 2)
    ).toEqual(['node', 'script', 'resources-read', 'file:///tmp/x']);
  });

  it('respects a bare (no node/script prefix) argument list via startIndex 0', () => {
    expect(normalizeSlashCommandArgs(['tools/list'], commands, 0)).toEqual(['tools-list']);
  });
});

describe('preProcessX402Argv', () => {
  // Mirrors process.argv where indices 0 and 1 are node + script path.
  const head = ['node', 'mcpc'];

  it('rewrites `--x402 <url>` so the URL stays a positional', () => {
    expect(preProcessX402Argv([...head, 'connect', '--x402', 'mcp.apify.com', '@s'])).toEqual([
      ...head,
      'connect',
      '--x402=auto',
      'mcp.apify.com',
      '@s',
    ]);
  });

  it('passes `--x402 <scheme>` through unchanged for each valid scheme', () => {
    for (const scheme of ['auto', 'upto', 'exact']) {
      expect(preProcessX402Argv([...head, 'connect', '--x402', scheme, 'mcp.apify.com'])).toEqual([
        ...head,
        'connect',
        '--x402',
        scheme,
        'mcp.apify.com',
      ]);
    }
  });

  it('rewrites bare `--x402` at the end of argv to `--x402=auto`', () => {
    expect(preProcessX402Argv([...head, 'connect', 'mcp.apify.com', '--x402'])).toEqual([
      ...head,
      'connect',
      'mcp.apify.com',
      '--x402=auto',
    ]);
  });

  it('leaves `--x402=<scheme>` (equals form) untouched', () => {
    expect(preProcessX402Argv([...head, 'connect', '--x402=upto', 'mcp.apify.com'])).toEqual([
      ...head,
      'connect',
      '--x402=upto',
      'mcp.apify.com',
    ]);
  });

  it('rewrites `--x402 <invalid-scheme>` so the invalid token stays a positional', () => {
    // The bogus token then surfaces as an extra positional, which Commander rejects loudly.
    expect(preProcessX402Argv([...head, 'connect', '--x402', 'bogus', 'mcp.apify.com'])).toEqual([
      ...head,
      'connect',
      '--x402=auto',
      'bogus',
      'mcp.apify.com',
    ]);
  });

  it('does not touch the `x402` subcommand (no leading dashes)', () => {
    expect(preProcessX402Argv([...head, 'x402', 'sign', '--scheme', 'upto'])).toEqual([
      ...head,
      'x402',
      'sign',
      '--scheme',
      'upto',
    ]);
  });

  it('handles multiple `--x402` occurrences independently', () => {
    expect(
      preProcessX402Argv([...head, '--x402', 'mcp.apify.com', 'other', '--x402', 'exact'])
    ).toEqual([...head, '--x402=auto', 'mcp.apify.com', 'other', '--x402', 'exact']);
  });
});

describe('preProcessSkillArgv', () => {
  // Mirrors process.argv where indices 0 and 1 are node + script path.
  const head = ['node', 'mcpc'];

  it('rewrites bare `--skill` into `help --skill`', () => {
    expect(preProcessSkillArgv([...head, '--skill'])).toEqual([...head, 'help', '--skill']);
  });

  it('keeps global flags around the rewritten command', () => {
    expect(preProcessSkillArgv([...head, '--verbose', '--skill'])).toEqual([
      ...head,
      'help',
      '--verbose',
      '--skill',
    ]);
    expect(preProcessSkillArgv([...head, '--skill', '--timeout', '5'])).toEqual([
      ...head,
      'help',
      '--skill',
      '--timeout',
      '5',
    ]);
  });

  it('leaves `help --skill` untouched', () => {
    expect(preProcessSkillArgv([...head, 'help', '--skill'])).toEqual([...head, 'help', '--skill']);
  });

  it('leaves argv with any other positional untouched', () => {
    expect(preProcessSkillArgv([...head, '@s', '--skill'])).toEqual([...head, '@s', '--skill']);
    expect(preProcessSkillArgv([...head, '--skill', 'connect'])).toEqual([
      ...head,
      '--skill',
      'connect',
    ]);
  });

  it('lets `--help` win over `--skill`', () => {
    expect(preProcessSkillArgv([...head, '--skill', '--help'])).toEqual([
      ...head,
      '--skill',
      '--help',
    ]);
    expect(preProcessSkillArgv([...head, '-h', '--skill'])).toEqual([...head, '-h', '--skill']);
  });

  it('leaves argv without `--skill` untouched', () => {
    expect(preProcessSkillArgv([...head, 'help'])).toEqual([...head, 'help']);
  });
});
