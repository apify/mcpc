/**
 * Tests for `mcpc connect` helpers
 */

import { describe, it, expect } from 'vitest';
import { formatDiscoveredConfigPath } from '../../../src/cli/commands/connect.js';

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
