/**
 * Unit tests for OAuth flow utility functions
 */

import { validateClientMetadataUrl } from '../../../../src/lib/auth/oauth-utils.js';
import { explainOAuthRegistrationFailure } from '../../../../src/lib/auth/oauth-flow.js';
import { AuthError } from '../../../../src/lib/errors.js';

describe('explainOAuthRegistrationFailure', () => {
  const serverUrl = 'https://mcp.figma.com/mcp';

  it('rewrites the SDK non-JSON 403 error (Figma) into actionable guidance', () => {
    // The exact error the MCP SDK surfaces for Figma's plain-text "Forbidden" body.
    const raw = new Error(
      "HTTP 403: Invalid OAuth error response: SyntaxError: Unexpected token 'F', " +
        '"Forbidden" is not valid JSON. Raw body: Forbidden'
    );

    const result = explainOAuthRegistrationFailure(raw, {
      serverUrl,
      reachedAuthorization: false,
    });

    expect(result).toBeInstanceOf(AuthError);
    const message = (result as AuthError).message;
    expect(message).toContain('refused to register mcpc');
    expect(message).toContain('HTTP 403');
    expect(message).toContain('--client-id');
    expect(message).toContain('--client-metadata-url');
    // The server host, not the raw SyntaxError, leads the message.
    expect(message).toContain('mcp.figma.com');
    // Original cause is preserved for --verbose / details.
    expect((result as AuthError).details).toEqual({ originalError: raw.message });
  });

  it('explains servers that expose no registration endpoint', () => {
    const raw = new Error('Incompatible auth server: does not support dynamic client registration');

    const result = explainOAuthRegistrationFailure(raw, {
      serverUrl,
      reachedAuthorization: false,
    });

    expect(result).toBeInstanceOf(AuthError);
    expect((result as AuthError).message).toContain('does not support Dynamic Client Registration');
  });

  it('handles a bare 403/forbidden message', () => {
    const raw = new Error('Forbidden');

    const result = explainOAuthRegistrationFailure(raw, {
      serverUrl,
      reachedAuthorization: false,
    });

    expect(result).toBeInstanceOf(AuthError);
  });

  it('leaves the error unchanged once authorization has been reached', () => {
    // A 403 after the redirect is a token-exchange/other failure, not registration.
    const raw = new Error('HTTP 403: Invalid OAuth error response. Raw body: Forbidden');

    const result = explainOAuthRegistrationFailure(raw, {
      serverUrl,
      reachedAuthorization: true,
    });

    expect(result).toBe(raw);
  });

  it('leaves unrelated pre-authorization errors unchanged', () => {
    const raw = new Error('connect ECONNREFUSED 127.0.0.1:3845');

    const result = explainOAuthRegistrationFailure(raw, {
      serverUrl,
      reachedAuthorization: false,
    });

    expect(result).toBe(raw);
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
