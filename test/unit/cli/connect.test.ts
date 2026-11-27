/**
 * Tests for `mcpc connect` helpers
 */

import { describe, it, expect } from 'vitest';
import { formatDiscoveredConfigPath, isSameServer } from '../../../src/cli/commands/connect.js';

describe('formatDiscoveredConfigPath', () => {
  const posix = (file: string, cwd = '/home/user/project') =>
    formatDiscoveredConfigPath(file, cwd, '/');
  const win32 = (file: string, cwd = 'D:\\a\\mcpc\\project') =>
    formatDiscoveredConfigPath(file, cwd, '\\');

  it('makes a file in the current directory relative with a ./ prefix', () => {
    expect(posix('/home/user/project/.mcp.json')).toBe('./.mcp.json');
  });

  it('keeps nested paths under the current directory', () => {
    expect(posix('/home/user/project/.vscode/mcp.json')).toBe('./.vscode/mcp.json');
  });

  // The hint is pasted into a shell, and Git Bash/WSL eat the backslashes of a `.\` path.
  it('spells Windows paths with forward slashes', () => {
    expect(win32('D:\\a\\mcpc\\project\\.mcp.json')).toBe('./.mcp.json');
    expect(win32('D:\\a\\mcpc\\project\\.vscode\\mcp.json')).toBe('./.vscode/mcp.json');
  });

  it('leaves files outside the current directory absolute and platform-native', () => {
    expect(posix('/home/user/.cursor/mcp.json')).toBe('/home/user/.cursor/mcp.json');
    expect(win32('C:\\Users\\me\\.cursor\\mcp.json')).toBe('C:\\Users\\me\\.cursor\\mcp.json');
  });

  // A sibling directory whose name merely starts with the cwd is not inside it.
  it('does not treat a same-prefix sibling directory as relative', () => {
    expect(posix('/home/user/project-other/.mcp.json')).toBe('/home/user/project-other/.mcp.json');
  });
});

describe('isSameServer', () => {
  it('matches the same URL however it is written', () => {
    expect(isSameServer({ url: 'https://mcp.example.com' }, { url: 'mcp.example.com' })).toBe(true);
    expect(
      isSameServer({ url: 'https://mcp.example.com/mcp' }, { url: 'https://MCP.example.com/mcp' })
    ).toBe(true);
  });

  it('tells apart hosts, ports, paths and schemes', () => {
    const base = { url: 'https://mcp.example.com/mcp' };
    expect(isSameServer(base, { url: 'https://other.example.com/mcp' })).toBe(false);
    expect(isSameServer(base, { url: 'https://mcp.example.com:8443/mcp' })).toBe(false);
    expect(isSameServer(base, { url: 'https://mcp.example.com/other' })).toBe(false);
    expect(isSameServer(base, { url: 'http://mcp.example.com/mcp' })).toBe(false);
  });

  it('ignores headers: they are settings of a connection, not the server identity', () => {
    expect(
      isSameServer(
        { url: 'https://mcp.example.com', headers: { Authorization: '<redacted>' } },
        { url: 'https://mcp.example.com' }
      )
    ).toBe(true);
  });

  it('matches a stdio server by its whole command line', () => {
    const base = { command: 'node', args: ['server.js', '--port', '1'] };
    expect(isSameServer(base, { command: 'node', args: ['server.js', '--port', '1'] })).toBe(true);
    expect(isSameServer(base, { command: 'node', args: ['server.js', '--port', '2'] })).toBe(false);
    expect(isSameServer(base, { command: 'bun', args: ['server.js', '--port', '1'] })).toBe(false);
    expect(isSameServer({ command: 'node' }, { command: 'node', args: [] })).toBe(true);
  });

  it('never matches an HTTP server with a stdio one', () => {
    expect(isSameServer({ url: 'https://mcp.example.com' }, { command: 'node' })).toBe(false);
    expect(isSameServer({ command: 'node' }, { url: 'https://mcp.example.com' })).toBe(false);
  });
});
