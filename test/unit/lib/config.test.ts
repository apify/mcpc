/**
 * Unit tests for config file loading
 */

import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  loadConfig,
  getServerConfig,
  validateServerConfig,
  listServers,
  isStdioEntry,
  getStandardMcpConfigPaths,
  discoverMcpConfigFiles,
  scanMcpConfigFiles,
} from '../../../src/lib/config.js';
import { ClientError } from '../../../src/lib/errors.js';
import type { McpConfig } from '../../../src/lib/types.js';

const TEST_DIR = join(process.cwd(), 'test-tmp-config');

beforeAll(() => {
  // Create test directory
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  // Clean up test directory
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('should load valid config file', () => {
    const configPath = join(TEST_DIR, 'valid-config.json');
    const configContent = {
      mcpServers: {
        'test-server': {
          url: 'https://test.example.com',
          headers: { 'X-Test': 'value' },
        },
      },
    };

    writeFileSync(configPath, JSON.stringify(configContent));

    const config = loadConfig(configPath);
    expect(config.mcpServers).toHaveProperty('test-server');
    const testServer = config.mcpServers['test-server'];
    expect(testServer).toBeDefined();
    expect(testServer?.url).toBe('https://test.example.com');
  });

  it('should throw on missing file', () => {
    const configPath = join(TEST_DIR, 'non-existent.json');
    expect(() => loadConfig(configPath)).toThrow(ClientError);
    expect(() => loadConfig(configPath)).toThrow('Config file not found');
  });

  it('should throw on invalid JSON', () => {
    const configPath = join(TEST_DIR, 'invalid.json');
    writeFileSync(configPath, '{ invalid json }');

    expect(() => loadConfig(configPath)).toThrow(ClientError);
    expect(() => loadConfig(configPath)).toThrow('Invalid JSON');
  });

  it('should throw on missing mcpServers field', () => {
    const configPath = join(TEST_DIR, 'no-servers.json');
    writeFileSync(configPath, JSON.stringify({ other: 'field' }));

    expect(() => loadConfig(configPath)).toThrow(ClientError);
    expect(() => loadConfig(configPath)).toThrow('missing or invalid "mcpServers"');
  });
});

describe('getServerConfig', () => {
  const config = {
    mcpServers: {
      'http-server': {
        url: 'https://api.example.com',
        headers: { Authorization: 'Bearer ${API_TOKEN}' },
        timeout: 60,
      },
      'stdio-server': {
        command: 'node',
        args: ['server.js'],
        env: { DEBUG: '${DEBUG_MODE}' },
      },
    },
  };

  beforeEach(() => {
    // Set test environment variables
    process.env.API_TOKEN = 'test-token-123';
    process.env.DEBUG_MODE = 'true';
  });

  afterEach(() => {
    // Clean up environment variables
    delete process.env.API_TOKEN;
    delete process.env.DEBUG_MODE;
  });

  it('should return server config by name', () => {
    const serverConfig = getServerConfig(config, 'http-server');
    expect(serverConfig.url).toBe('https://api.example.com');
    expect(serverConfig.timeout).toBe(60);
  });

  it('should substitute environment variables in HTTP config', () => {
    const serverConfig = getServerConfig(config, 'http-server');
    expect(serverConfig.headers?.Authorization).toBe('Bearer test-token-123');
  });

  it('should substitute environment variables in stdio config', () => {
    const serverConfig = getServerConfig(config, 'stdio-server');
    expect(serverConfig.env?.DEBUG).toBe('true');
  });

  it('should use empty string for missing environment variables', () => {
    delete process.env.API_TOKEN;
    const serverConfig = getServerConfig(config, 'http-server');
    expect(serverConfig.headers?.Authorization).toBe('Bearer ');
  });

  it('should throw on non-existent server', () => {
    expect(() => getServerConfig(config, 'non-existent')).toThrow(ClientError);
    expect(() => getServerConfig(config, 'non-existent')).toThrow(
      'Server "non-existent" not found'
    );
  });

  it('should list available servers in error message', () => {
    expect(() => getServerConfig(config, 'unknown')).toThrow(
      'Available servers: http-server, stdio-server'
    );
  });

  it('should preserve protocolVersion from the config entry', () => {
    const pinned = {
      mcpServers: {
        pinned: { url: 'https://api.example.com', protocolVersion: '2024-10-07' },
      },
    };
    expect(getServerConfig(pinned, 'pinned').protocolVersion).toBe('2024-10-07');
  });

  it('should pass through fields it does not substitute', () => {
    // Guards against the copier silently dropping fields it does not know about
    // (both future ServerConfig fields and keys used by other MCP clients).
    const extra = {
      mcpServers: {
        server: { url: 'https://api.example.com', type: 'http', futureField: 42 },
      },
    } as unknown as McpConfig;
    const serverConfig = getServerConfig(extra, 'server') as Record<string, unknown>;
    expect(serverConfig.type).toBe('http');
    expect(serverConfig.futureField).toBe(42);
  });
});

describe('validateServerConfig', () => {
  it('should validate HTTP server config', () => {
    const config = { url: 'https://api.example.com' };
    expect(validateServerConfig(config)).toBe(true);
  });

  it('should validate stdio server config', () => {
    const config = { command: 'node', args: ['server.js'] };
    expect(validateServerConfig(config)).toBe(true);
  });

  it('should reject config without url or command', () => {
    const config = { timeout: 60 };
    expect(() => validateServerConfig(config)).toThrow(ClientError);
    expect(() => validateServerConfig(config)).toThrow(
      'must specify either "url" (for HTTP) or "command" (for stdio)'
    );
  });

  it('should reject config with both url and command', () => {
    const config = { url: 'https://example.com', command: 'node' };
    expect(() => validateServerConfig(config)).toThrow(ClientError);
    expect(() => validateServerConfig(config)).toThrow('cannot specify both "url" and "command"');
  });

  it('should reject invalid URL protocol', () => {
    const config = { url: 'ftp://example.com' };
    expect(() => validateServerConfig(config)).toThrow(ClientError);
    expect(() => validateServerConfig(config)).toThrow('must start with http:// or https://');
  });

  it('should reject empty command', () => {
    const config = { command: '' };
    expect(() => validateServerConfig(config)).toThrow(ClientError);
    expect(() => validateServerConfig(config)).toThrow('must be a non-empty string');
  });
});

describe('isStdioEntry', () => {
  it('returns true for entries with a command field', () => {
    const config = {
      mcpServers: {
        local: { command: 'node', args: ['server.js'] },
      },
    };
    expect(isStdioEntry(config, 'local')).toBe(true);
  });

  it('returns false for entries with a url field', () => {
    const config = {
      mcpServers: {
        remote: { url: 'https://example.com' },
      },
    };
    expect(isStdioEntry(config, 'remote')).toBe(false);
  });

  it('returns false for non-existent entries', () => {
    const config = {
      mcpServers: {
        remote: { url: 'https://example.com' },
      },
    };
    expect(isStdioEntry(config, 'missing')).toBe(false);
  });

  it('correctly distinguishes entries in a mixed config', () => {
    const config = {
      mcpServers: {
        http: { url: 'https://example.com' },
        stdio: { command: 'npx', args: ['-y', 'mcp-server'] },
      },
    };
    expect(isStdioEntry(config, 'http')).toBe(false);
    expect(isStdioEntry(config, 'stdio')).toBe(true);
  });
});

describe('listServers', () => {
  it('should list all server names', () => {
    const config = {
      mcpServers: {
        server1: { url: 'https://example.com' },
        server2: { command: 'node' },
        server3: { url: 'https://test.com' },
      },
    };

    const servers = listServers(config);
    expect(servers).toEqual(['server1', 'server2', 'server3']);
  });

  it('should return empty array for empty config', () => {
    const config = { mcpServers: {} };
    const servers = listServers(config);
    expect(servers).toEqual([]);
  });
});

describe('environment variable substitution', () => {
  beforeEach(() => {
    process.env.TEST_VAR = 'test-value';
    process.env.ANOTHER_VAR = 'another-value';
  });

  afterEach(() => {
    delete process.env.TEST_VAR;
    delete process.env.ANOTHER_VAR;
  });

  it('should substitute multiple variables in URL', () => {
    const config = {
      mcpServers: {
        test: {
          url: 'https://${TEST_VAR}.example.com/${ANOTHER_VAR}',
        },
      },
    };

    const serverConfig = getServerConfig(config, 'test');
    expect(serverConfig.url).toBe('https://test-value.example.com/another-value');
  });

  it('should substitute variables in command and args', () => {
    const config = {
      mcpServers: {
        test: {
          command: '${TEST_VAR}',
          args: ['--flag=${ANOTHER_VAR}'],
        },
      },
    };

    const serverConfig = getServerConfig(config, 'test');
    expect(serverConfig.command).toBe('test-value');
    expect(serverConfig.args).toEqual(['--flag=another-value']);
  });

  it('should not substitute if no variables present', () => {
    const config = {
      mcpServers: {
        test: {
          url: 'https://example.com',
        },
      },
    };

    const serverConfig = getServerConfig(config, 'test');
    expect(serverConfig.url).toBe('https://example.com');
  });
});

describe('getStandardMcpConfigPaths', () => {
  it('returns project-scoped paths first, then global', () => {
    const paths = getStandardMcpConfigPaths({
      homeDir: '/home/alice',
      cwd: '/work/project',
      platform: 'linux',
    });

    // Project scope first
    expect(paths[0]?.scope).toBe('project');
    // Global scope afterwards
    const firstGlobalIdx = paths.findIndex((p) => p.scope === 'global');
    expect(firstGlobalIdx).toBeGreaterThan(0);
    // All 'project' entries come before all 'global' entries
    for (let i = 0; i < firstGlobalIdx; i++) {
      expect(paths[i]?.scope).toBe('project');
    }
    for (let i = firstGlobalIdx; i < paths.length; i++) {
      expect(paths[i]?.scope).toBe('global');
    }
  });

  it('includes standard project-level locations under cwd', () => {
    const paths = getStandardMcpConfigPaths({
      homeDir: '/home/alice',
      cwd: '/work/project',
      platform: 'linux',
    });
    const projectPaths = paths.filter((p) => p.scope === 'project').map((p) => p.path);
    expect(projectPaths).toContain('/work/project/.mcp.json');
    expect(projectPaths).toContain('/work/project/mcp.json');
    expect(projectPaths).toContain('/work/project/mcp_config.json');
    expect(projectPaths).toContain('/work/project/.cursor/mcp.json');
    expect(projectPaths).toContain('/work/project/.vscode/mcp.json');
    expect(projectPaths).toContain('/work/project/.kiro/settings/mcp.json');
  });

  it('includes standard global locations under homeDir', () => {
    const paths = getStandardMcpConfigPaths({
      homeDir: '/home/alice',
      cwd: '/work/project',
      platform: 'linux',
    });
    const globalPaths = paths.filter((p) => p.scope === 'global').map((p) => p.path);
    expect(globalPaths).toContain('/home/alice/.cursor/mcp.json');
    expect(globalPaths).toContain('/home/alice/.vscode/mcp.json');
    expect(globalPaths).toContain('/home/alice/.codeium/windsurf/mcp_config.json');
    expect(globalPaths).toContain('/home/alice/.kiro/settings/mcp.json');
    expect(globalPaths).toContain('/home/alice/.claude.json');
  });

  it('uses macOS-specific VS Code and Claude Desktop paths on darwin', () => {
    const paths = getStandardMcpConfigPaths({
      homeDir: '/Users/alice',
      cwd: '/work',
      platform: 'darwin',
    });
    const paths_ = paths.map((p) => p.path);
    expect(paths_).toContain('/Users/alice/Library/Application Support/Code/User/mcp.json');
    expect(paths_).toContain(
      '/Users/alice/Library/Application Support/Claude/claude_desktop_config.json'
    );
  });

  it('uses Linux XDG-style VS Code and Claude Desktop paths', () => {
    const paths = getStandardMcpConfigPaths({
      homeDir: '/home/alice',
      cwd: '/work',
      platform: 'linux',
    });
    const paths_ = paths.map((p) => p.path);
    expect(paths_).toContain('/home/alice/.config/Code/User/mcp.json');
    expect(paths_).toContain('/home/alice/.config/Claude/claude_desktop_config.json');
  });

  it('uses APPDATA-based VS Code and Claude Desktop paths on win32', () => {
    const paths = getStandardMcpConfigPaths({
      homeDir: 'C:\\Users\\alice',
      cwd: 'C:\\work',
      platform: 'win32',
      appData: 'C:\\Users\\alice\\AppData\\Roaming',
    });
    const paths_ = paths.map((p) => p.path);
    expect(paths_.some((p) => p.includes('Code') && p.endsWith('mcp.json'))).toBe(true);
    expect(
      paths_.some((p) => p.includes('Claude') && p.endsWith('claude_desktop_config.json'))
    ).toBe(true);
  });

  it('omits VS Code and Claude Desktop entries on win32 when APPDATA is missing', () => {
    const paths = getStandardMcpConfigPaths({
      homeDir: 'C:\\Users\\alice',
      cwd: 'C:\\work',
      platform: 'win32',
      appData: undefined,
    });
    const paths_ = paths.map((p) => p.path);
    expect(paths_.some((p) => p.includes('claude_desktop_config.json'))).toBe(false);
  });

  it('deduplicates paths when cwd equals homeDir', () => {
    // If someone runs from their home directory, project-scoped and global paths may overlap.
    const paths = getStandardMcpConfigPaths({
      homeDir: '/home/alice',
      cwd: '/home/alice',
      platform: 'linux',
    });
    const pathStrs = paths.map((p) => p.path);
    const unique = new Set(pathStrs);
    expect(pathStrs.length).toBe(unique.size);
  });
});

describe('discoverMcpConfigFiles', () => {
  const DISCOVERY_TMP = join(process.cwd(), 'test-tmp-discovery');

  beforeEach(() => {
    rmSync(DISCOVERY_TMP, { recursive: true, force: true });
    mkdirSync(DISCOVERY_TMP, { recursive: true });
  });

  afterAll(() => {
    rmSync(DISCOVERY_TMP, { recursive: true, force: true });
  });

  it('returns empty array when no config files exist', () => {
    const emptyHome = join(DISCOVERY_TMP, 'home-empty');
    const emptyCwd = join(DISCOVERY_TMP, 'cwd-empty');
    mkdirSync(emptyHome, { recursive: true });
    mkdirSync(emptyCwd, { recursive: true });

    const discovered = discoverMcpConfigFiles({
      homeDir: emptyHome,
      cwd: emptyCwd,
      platform: 'linux',
    });
    expect(discovered).toEqual([]);
  });

  it('discovers a project-scope .mcp.json', () => {
    const home = join(DISCOVERY_TMP, 'home-a');
    const cwd = join(DISCOVERY_TMP, 'cwd-a');
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          foo: { url: 'https://foo.example.com' },
        },
      })
    );

    const discovered = discoverMcpConfigFiles({
      homeDir: home,
      cwd,
      platform: 'linux',
    });
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.scope).toBe('project');
    expect(discovered[0]?.serverCount).toBe(1);
    expect(Object.keys(discovered[0]?.config.mcpServers ?? {})).toEqual(['foo']);
  });

  it('discovers a project-scope mcp.json (without dot prefix)', () => {
    const home = join(DISCOVERY_TMP, 'home-a2');
    const cwd = join(DISCOVERY_TMP, 'cwd-a2');
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    writeFileSync(
      join(cwd, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          bar: { url: 'https://bar.example.com' },
        },
      })
    );

    const discovered = discoverMcpConfigFiles({
      homeDir: home,
      cwd,
      platform: 'linux',
    });
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.scope).toBe('project');
    expect(discovered[0]?.serverCount).toBe(1);
  });

  it('discovers a config using VS Code "servers" key (normalized to mcpServers)', () => {
    const home = join(DISCOVERY_TMP, 'home-vscode');
    const cwd = join(DISCOVERY_TMP, 'cwd-vscode');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(cwd, '.vscode'), { recursive: true });

    writeFileSync(
      join(cwd, '.vscode/mcp.json'),
      JSON.stringify({
        servers: {
          myserver: { url: 'https://myserver.example.com', type: 'http' },
        },
      })
    );

    const discovered = discoverMcpConfigFiles({
      homeDir: home,
      cwd,
      platform: 'linux',
    });
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.serverCount).toBe(1);
    expect(Object.keys(discovered[0]?.config.mcpServers ?? {})).toEqual(['myserver']);
  });

  it('discovers a global ~/.cursor/mcp.json', () => {
    const home = join(DISCOVERY_TMP, 'home-b');
    const cwd = join(DISCOVERY_TMP, 'cwd-b');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    mkdirSync(cwd, { recursive: true });

    writeFileSync(
      join(home, '.cursor/mcp.json'),
      JSON.stringify({
        mcpServers: {
          bar: { url: 'https://bar.example.com' },
        },
      })
    );

    const discovered = discoverMcpConfigFiles({
      homeDir: home,
      cwd,
      platform: 'linux',
    });
    expect(discovered.some((d) => d.path.includes('.cursor/mcp.json'))).toBe(true);
  });

  it('returns project configs before global configs', () => {
    const home = join(DISCOVERY_TMP, 'home-c');
    const cwd = join(DISCOVERY_TMP, 'cwd-c');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    mkdirSync(join(cwd, '.cursor'), { recursive: true });

    writeFileSync(
      join(cwd, '.cursor/mcp.json'),
      JSON.stringify({ mcpServers: { a: { url: 'https://a.example.com' } } })
    );
    writeFileSync(
      join(home, '.cursor/mcp.json'),
      JSON.stringify({ mcpServers: { b: { url: 'https://b.example.com' } } })
    );

    const discovered = discoverMcpConfigFiles({
      homeDir: home,
      cwd,
      platform: 'linux',
    });
    expect(discovered).toHaveLength(2);
    expect(discovered[0]?.scope).toBe('project');
    expect(discovered[1]?.scope).toBe('global');
  });

  it('silently skips files without an mcpServers field', () => {
    const home = join(DISCOVERY_TMP, 'home-d');
    const cwd = join(DISCOVERY_TMP, 'cwd-d');
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    // ~/.claude.json exists but has no mcpServers (common case for Claude Code users)
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 5, theme: 'dark' }));

    const discovered = discoverMcpConfigFiles({
      homeDir: home,
      cwd,
      platform: 'linux',
    });
    expect(discovered).toHaveLength(0);
  });

  it('skips files with empty mcpServers object', () => {
    const home = join(DISCOVERY_TMP, 'home-e');
    const cwd = join(DISCOVERY_TMP, 'cwd-e');
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: {} }));

    const discovered = discoverMcpConfigFiles({
      homeDir: home,
      cwd,
      platform: 'linux',
    });
    expect(discovered).toHaveLength(0);
  });

  it('skips files with invalid JSON without throwing', () => {
    const home = join(DISCOVERY_TMP, 'home-f');
    const cwd = join(DISCOVERY_TMP, 'cwd-f');
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    writeFileSync(join(cwd, '.mcp.json'), '{ not valid json');

    expect(() =>
      discoverMcpConfigFiles({
        homeDir: home,
        cwd,
        platform: 'linux',
      })
    ).not.toThrow();
  });

  it('discovers multiple config files across project and global scopes', () => {
    const home = join(DISCOVERY_TMP, 'home-g');
    const cwd = join(DISCOVERY_TMP, 'cwd-g');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    mkdirSync(join(home, '.vscode'), { recursive: true });
    mkdirSync(join(cwd, '.vscode'), { recursive: true });

    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { p: { url: 'https://p.example.com' } } })
    );
    writeFileSync(
      join(cwd, '.vscode/mcp.json'),
      JSON.stringify({ mcpServers: { q: { url: 'https://q.example.com' } } })
    );
    writeFileSync(
      join(home, '.cursor/mcp.json'),
      JSON.stringify({ mcpServers: { r: { url: 'https://r.example.com' } } })
    );
    writeFileSync(
      join(home, '.vscode/mcp.json'),
      JSON.stringify({ mcpServers: { s: { url: 'https://s.example.com' } } })
    );

    const discovered = discoverMcpConfigFiles({
      homeDir: home,
      cwd,
      platform: 'linux',
    });
    const paths = discovered.map((d) => d.path);
    expect(paths).toHaveLength(4);
    expect(paths[0]).toContain('.mcp.json');
    expect(paths[1]).toContain('.vscode/mcp.json');
    expect(paths[2]).toContain('.cursor/mcp.json');
    expect(paths[3]).toContain('.vscode/mcp.json');
  });
});

describe('scanMcpConfigFiles', () => {
  const SCAN_TMP = join(process.cwd(), 'test-tmp-scan');

  beforeEach(() => {
    rmSync(SCAN_TMP, { recursive: true, force: true });
    mkdirSync(SCAN_TMP, { recursive: true });
  });

  afterAll(() => {
    rmSync(SCAN_TMP, { recursive: true, force: true });
  });

  function freshDirs(suffix: string): { home: string; cwd: string } {
    const home = join(SCAN_TMP, `home-${suffix}`);
    const cwd = join(SCAN_TMP, `cwd-${suffix}`);
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    return { home, cwd };
  }

  it('partitions an empty-mcpServers file into `empty`, not `discovered`', () => {
    const { home, cwd } = freshDirs('empty');
    writeFileSync(join(cwd, 'mcp.json'), JSON.stringify({ mcpServers: {} }));

    const scan = scanMcpConfigFiles({ homeDir: home, cwd, platform: 'linux' });
    expect(scan.discovered).toHaveLength(0);
    expect(scan.empty).toHaveLength(1);
    expect(scan.empty[0]?.path).toContain('mcp.json');
  });

  it('returns a populated config under `discovered` with no `empty` entries', () => {
    const { home, cwd } = freshDirs('usable');
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { foo: { url: 'https://foo.example.com' } } })
    );

    const scan = scanMcpConfigFiles({ homeDir: home, cwd, platform: 'linux' });
    expect(scan.discovered).toHaveLength(1);
    expect(scan.discovered[0]?.serverCount).toBe(1);
    expect(scan.empty).toEqual([]);
  });

  it('does not surface global files without a servers field (e.g. ~/.claude.json app state)', () => {
    const { home, cwd } = freshDirs('no-key');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 5, theme: 'dark' }));

    const scan = scanMcpConfigFiles({ homeDir: home, cwd, platform: 'linux' });
    expect(scan.discovered).toEqual([]);
    expect(scan.empty).toEqual([]);
    expect(scan.errors).toEqual([]);
  });

  it('flags a project file with no servers object as an error', () => {
    const { home, cwd } = freshDirs('no-servers-project');
    writeFileSync(join(cwd, 'mcp.json'), JSON.stringify({ x: {} }));

    const scan = scanMcpConfigFiles({ homeDir: home, cwd, platform: 'linux' });
    expect(scan.discovered).toEqual([]);
    expect(scan.empty).toEqual([]);
    expect(scan.errors).toHaveLength(1);
    expect(scan.errors[0]?.path).toContain('mcp.json');
    expect(scan.errors[0]?.error).toContain('mcpServers');
  });

  it('captures invalid JSON in `errors` without echoing the file content', () => {
    const { home, cwd } = freshDirs('bad-json');
    writeFileSync(join(cwd, 'mcp.json'), '!INJECTED_MARKER');

    const scan = scanMcpConfigFiles({ homeDir: home, cwd, platform: 'linux' });
    expect(scan.discovered).toEqual([]);
    expect(scan.empty).toEqual([]);
    expect(scan.errors).toHaveLength(1);
    expect(scan.errors[0]?.path).toContain('mcp.json');
    expect(scan.errors[0]?.error.length).toBeGreaterThan(0);
    // The file's content must not be echoed back (layout + prompt-injection safety).
    expect(scan.errors[0]?.error).not.toContain('INJECTED_MARKER');
  });
});
