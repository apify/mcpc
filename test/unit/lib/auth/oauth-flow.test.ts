/**
 * Unit tests for OAuth flow utility functions
 */

import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/client';
import { validateClientMetadataUrl } from '../../../../src/lib/auth/oauth-utils.js';
import { explainOAuthRegistrationFailure } from '../../../../src/lib/auth/oauth-flow.js';
import { AuthError } from '../../../../src/lib/errors.js';

describe('explainOAuthRegistrationFailure', () => {
  const serverUrl = 'https://mcp.figma.com/mcp';
  const preAuth = { serverUrl, reachedAuthorization: false };

  it('rewrites the SDK non-JSON 403 error (Figma) into allow-list guidance', () => {
    // The exact error the MCP SDK surfaces for Figma's plain-text "Forbidden" body.
    const raw = new OAuthError(
      OAuthErrorCode.ServerError,
      "HTTP 403: Invalid OAuth error response: SyntaxError: Unexpected token 'F', " +
        '"Forbidden" is not valid JSON. Raw body: Forbidden'
    );

    const result = explainOAuthRegistrationFailure(raw, preAuth);

    expect(result).toBeInstanceOf(AuthError);
    const message = (result as AuthError).message;
    expect(message).toContain('mcp.figma.com refused to register mcpc');
    expect(message).toContain('(HTTP 403)');
    expect(message).toContain('--client-id');
    expect(message).toContain('--client-metadata-url');
    // The underlying server response stays visible (login prints only error.message).
    expect(message).toContain('Server response:');
    expect(message).toContain('Raw body: Forbidden');
    expect((result as AuthError).details).toEqual({ originalError: raw.message });
  });

  it('recognizes a 401/403 registration rejection even when the error is untyped', () => {
    const raw = new Error('HTTP 401: Invalid OAuth error response: foo. Raw body: Unauthorized');

    const result = explainOAuthRegistrationFailure(raw, preAuth);

    expect(result).toBeInstanceOf(AuthError);
    expect((result as AuthError).message).toContain('refused to register mcpc');
  });

  it('recognizes OAuth-coded client rejections without an HTTP status', () => {
    const raw = new OAuthError(OAuthErrorCode.InvalidClient, 'mcpc is not an approved client');

    const result = explainOAuthRegistrationFailure(raw, preAuth);

    expect(result).toBeInstanceOf(AuthError);
    const message = (result as AuthError).message;
    expect(message).toContain('refused to register mcpc as an OAuth client.');
    expect(message).toContain('Server response: mcpc is not an approved client');
  });

  it('explains servers that expose no registration endpoint', () => {
    const raw = new Error('Incompatible auth server: does not support dynamic client registration');

    const result = explainOAuthRegistrationFailure(raw, preAuth);

    expect(result).toBeInstanceOf(AuthError);
    const message = (result as AuthError).message;
    expect(message).toContain('does not support Dynamic Client Registration');
    expect(message).toContain('--client-id');
  });

  it('does not claim an allow-list for a registration 5xx', () => {
    const raw = new OAuthError(
      OAuthErrorCode.ServerError,
      'HTTP 500: Invalid OAuth error response: SyntaxError: bad. Raw body: <html>outage</html>'
    );

    const result = explainOAuthRegistrationFailure(raw, preAuth);

    expect(result).toBeInstanceOf(AuthError);
    const message = (result as AuthError).message;
    expect(message).toContain('Client registration with mcp.figma.com failed:');
    expect(message).not.toContain('refused to register');
    expect(message).not.toContain('allow-list');
    expect(message).toContain('--client-id');
  });

  it('reports rejected client metadata without claiming an allow-list', () => {
    const raw = new OAuthError(OAuthErrorCode.InvalidClientMetadata, 'redirect_uri is not allowed');

    const result = explainOAuthRegistrationFailure(raw, preAuth);

    expect(result).toBeInstanceOf(AuthError);
    const message = (result as AuthError).message;
    expect(message).toContain('Client registration with mcp.figma.com failed:');
    expect(message).toContain('redirect_uri is not allowed');
    expect(message).not.toContain('refused to register');
  });

  it('truncates oversized response bodies in the message but keeps details intact', () => {
    const body = 'x'.repeat(2000);
    const raw = new OAuthError(
      OAuthErrorCode.ServerError,
      `HTTP 403: Invalid OAuth error response: bad. Raw body: ${body}`
    );

    const result = explainOAuthRegistrationFailure(raw, preAuth);

    const message = (result as AuthError).message;
    expect(message).toContain('…');
    expect(message).not.toContain(body);
    expect((result as AuthError).details).toEqual({ originalError: raw.message });
  });

  it('leaves the error unchanged once authorization has been reached', () => {
    // A 403 after the redirect is a token-exchange failure, not registration.
    const raw = new OAuthError(
      OAuthErrorCode.ServerError,
      'HTTP 403: Invalid OAuth error response. Raw body: Forbidden'
    );

    const result = explainOAuthRegistrationFailure(raw, { serverUrl, reachedAuthorization: true });

    expect(result).toBe(raw);
  });

  it('leaves unrelated pre-authorization errors unchanged', () => {
    for (const raw of [
      new Error('connect ECONNREFUSED 127.0.0.1:3845'),
      new Error('Forbidden'), // no HTTP status, not an SDK OAuth error
      new Error('Authentication cancelled by user'),
    ]) {
      expect(explainOAuthRegistrationFailure(raw, preAuth)).toBe(raw);
    }
  });
});

describe('validateClientMetadataUrl', () => {
  it('accepts a valid HTTPS URL with path', () => {
    expect(() =>
      validateClientMetadataUrl('https://example.com/client-metadata/v1.json')
    ).not.toThrow();
  });

  it('accepts a URL with a port', () => {
    expect(() => validateClientMetadataUrl('https://example.com:8443/client.json')).not.toThrow();
  });

  it('rejects a non-HTTPS URL', () => {
    expect(() => validateClientMetadataUrl('http://example.com/client.json')).toThrow(
      /"https" scheme/
    );
  });

  it('rejects a URL without a path component', () => {
    expect(() => validateClientMetadataUrl('https://example.com')).toThrow(/path component/);
  });

  it('rejects a URL with only a root path', () => {
    expect(() => validateClientMetadataUrl('https://example.com/')).toThrow(/path component/);
  });

  it('rejects an invalid URL', () => {
    expect(() => validateClientMetadataUrl('not-a-url')).toThrow(/not a valid URL/);
  });

  it('rejects a URL with a fragment', () => {
    expect(() => validateClientMetadataUrl('https://example.com/client.json#section')).toThrow(
      /fragment/
    );
  });

  it('rejects a URL with a username', () => {
    expect(() => validateClientMetadataUrl('https://user@example.com/client.json')).toThrow(
      /username or password/
    );
  });

  it('rejects a URL with a username and password', () => {
    expect(() => validateClientMetadataUrl('https://user:pass@example.com/client.json')).toThrow(
      /username or password/
    );
  });

  it('rejects a URL with single-dot path segment', () => {
    expect(() => validateClientMetadataUrl('https://example.com/./client.json')).toThrow(
      /path segments/
    );
  });

  it('rejects a URL with double-dot path segment', () => {
    expect(() => validateClientMetadataUrl('https://example.com/../client.json')).toThrow(
      /path segments/
    );
  });

  it('accepts a URL with a query string', () => {
    expect(() => validateClientMetadataUrl('https://example.com/client.json?v=1')).not.toThrow();
  });
});
