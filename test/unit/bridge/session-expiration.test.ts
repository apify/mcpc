/**
 * Unit tests for session expiration detection and error enrichment
 */

import {
  isSessionExpiredError,
  isHttpRedirectError,
  enrichErrorMessage,
} from '../../../src/lib/utils.js';
import { isAuthenticationError } from '../../../src/lib/errors.js';

describe('isSessionExpiredError', () => {
  describe('explicit session messages (always detected regardless of hadActiveSession)', () => {
    it('detects "session not found" message', () => {
      expect(isSessionExpiredError('session not found')).toBe(true);
      expect(isSessionExpiredError('Session not found')).toBe(true);
      expect(isSessionExpiredError('SESSION NOT FOUND')).toBe(true);
    });

    it('detects "Session ID xyz not found" message (the bug fix case)', () => {
      expect(
        isSessionExpiredError(
          'Bad Request: Session ID 334c4cc0-ea1a-49f5-89a6-13bbe29b17d6 not found'
        )
      ).toBe(true);
      expect(isSessionExpiredError('Session ID abc123 not found')).toBe(true);
      expect(isSessionExpiredError('session id test-session not found')).toBe(true);
    });

    it('detects "session xyz not found" message (without "id" keyword)', () => {
      expect(isSessionExpiredError('session abc123 not found')).toBe(true);
      expect(isSessionExpiredError('Session test-session not found')).toBe(true);
    });

    it('detects "session expired" message', () => {
      expect(isSessionExpiredError('session expired')).toBe(true);
      expect(isSessionExpiredError('Your session expired')).toBe(true);
      expect(isSessionExpiredError('Session Expired')).toBe(true);
    });

    it('detects "invalid session" message', () => {
      expect(isSessionExpiredError('invalid session')).toBe(true);
      expect(isSessionExpiredError('Invalid session ID')).toBe(true);
      expect(isSessionExpiredError('Error: invalid session')).toBe(true);
    });

    it('detects "session is no longer valid" message', () => {
      expect(isSessionExpiredError('session is no longer valid')).toBe(true);
      expect(isSessionExpiredError('Your session is no longer valid')).toBe(true);
    });
  });

  describe('HTTP 404 with hadActiveSession context', () => {
    it('detects bare 404 when hadActiveSession is true', () => {
      expect(isSessionExpiredError('404 Not Found', { hadActiveSession: true })).toBe(true);
      expect(isSessionExpiredError('HTTP 404', { hadActiveSession: true })).toBe(true);
      expect(isSessionExpiredError('Error: 404', { hadActiveSession: true })).toBe(true);
    });

    it('does NOT detect bare 404 when hadActiveSession is false', () => {
      // A bare 404 during initial connect means wrong URL, not expired session
      expect(isSessionExpiredError('404 Not Found', { hadActiveSession: false })).toBe(false);
      expect(isSessionExpiredError('HTTP 404', { hadActiveSession: false })).toBe(false);
      expect(isSessionExpiredError('Error: 404', { hadActiveSession: false })).toBe(false);
    });

    it('does NOT detect bare 404 when hadActiveSession is not specified', () => {
      // Default behavior: bare 404 without context is not treated as session expiration
      expect(isSessionExpiredError('404 Not Found')).toBe(false);
      expect(isSessionExpiredError('HTTP 404')).toBe(false);
      expect(isSessionExpiredError('Error: 404')).toBe(false);
    });

    it('detects 404 mentioning "session" regardless of hadActiveSession', () => {
      // If the 404 message explicitly mentions "session", always treat as expiration
      expect(isSessionExpiredError('404 session not found')).toBe(true);
      expect(isSessionExpiredError('404 session not found', { hadActiveSession: false })).toBe(
        true
      );
      expect(isSessionExpiredError('404 session not found', { hadActiveSession: true })).toBe(true);
    });
  });

  describe('should NOT detect as session expiration', () => {
    it('ignores "tool not found" errors (404 with tool)', () => {
      expect(isSessionExpiredError('404 tool not found', { hadActiveSession: true })).toBe(false);
      expect(isSessionExpiredError('Tool xyz not found (404)', { hadActiveSession: true })).toBe(
        false
      );
      expect(
        isSessionExpiredError('Error 404: tool does not exist', { hadActiveSession: true })
      ).toBe(false);
    });

    it('ignores generic errors', () => {
      expect(isSessionExpiredError('Connection refused')).toBe(false);
      expect(isSessionExpiredError('Network error')).toBe(false);
      expect(isSessionExpiredError('Timeout')).toBe(false);
      expect(isSessionExpiredError('Internal server error')).toBe(false);
    });

    it('ignores unrelated "not found" errors', () => {
      expect(isSessionExpiredError('resource not found')).toBe(false);
      expect(isSessionExpiredError('file not found')).toBe(false);
      expect(isSessionExpiredError('user not found')).toBe(false);
    });

    it('ignores empty or whitespace messages', () => {
      expect(isSessionExpiredError('')).toBe(false);
      expect(isSessionExpiredError('   ')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles messages with leading/trailing whitespace', () => {
      expect(isSessionExpiredError('  session not found  ')).toBe(true);
      expect(isSessionExpiredError('  session expired  ')).toBe(true);
    });

    it('handles messages embedded in longer error strings', () => {
      expect(
        isSessionExpiredError(
          'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Session ID 334c4cc0-ea1a-49f5-89a6-13bbe29b17d6 not found"},"id":null}'
        )
      ).toBe(true);
    });

    it('is case-insensitive for all patterns', () => {
      expect(isSessionExpiredError('SESSION EXPIRED')).toBe(true);
      expect(isSessionExpiredError('INVALID SESSION')).toBe(true);
      expect(isSessionExpiredError('SESSION IS NO LONGER VALID')).toBe(true);
      expect(isSessionExpiredError('SESSION ID ABC NOT FOUND')).toBe(true);
    });
  });
});

describe('isHttpRedirectError', () => {
  it('detects redirect-related messages', () => {
    expect(isHttpRedirectError('redirect')).toBe(true);
    expect(isHttpRedirectError('301 Moved Permanently')).toBe(true);
    expect(isHttpRedirectError('302 Found')).toBe(true);
    expect(isHttpRedirectError('HTTP 307 Temporary Redirect')).toBe(true);
    expect(isHttpRedirectError('moved permanently')).toBe(true);
    expect(isHttpRedirectError('moved temporarily')).toBe(true);
  });

  it('does not match non-redirect messages', () => {
    expect(isHttpRedirectError('404 Not Found')).toBe(false);
    expect(isHttpRedirectError('Connection refused')).toBe(false);
    expect(isHttpRedirectError('200 OK')).toBe(false);
  });
});

describe('enrichErrorMessage', () => {
  it('enriches connection refused errors', () => {
    const result = enrichErrorMessage('ECONNREFUSED', 'https://mcp.example.com');
    expect(result).toContain('Cannot reach server');
    expect(result).toContain('https://mcp.example.com');
    expect(result).toContain('Is the server running?');
  });

  it('enriches DNS resolution errors', () => {
    const result = enrichErrorMessage('getaddrinfo ENOTFOUND bad.host', 'https://bad.host');
    expect(result).toContain('Cannot resolve hostname');
    expect(result).toContain('https://bad.host');
  });

  it('enriches 404 errors with URL', () => {
    const result = enrichErrorMessage('404 Not Found', 'https://mcp.example.com/wrong');
    expect(result).toContain('404 Not Found');
    expect(result).toContain('https://mcp.example.com/wrong');
    expect(result).toContain('Check the endpoint URL');
  });

  it('enriches redirect errors', () => {
    const result = enrichErrorMessage('301 Moved Permanently', 'https://example.com');
    expect(result).toContain("doesn't look like an MCP endpoint");
  });

  it('enriches timeout errors', () => {
    const result = enrichErrorMessage('ETIMEDOUT');
    expect(result).toContain('timed out');
  });

  it('enriches TLS/SSL errors', () => {
    const result = enrichErrorMessage('self-signed certificate in certificate chain');
    expect(result).toContain('TLS/SSL error');
  });

  it('returns original message when no pattern matches', () => {
    const msg = 'some unknown error';
    expect(enrichErrorMessage(msg)).toBe(msg);
  });

  it('works without serverUrl', () => {
    const result = enrichErrorMessage('ECONNREFUSED');
    expect(result).toContain('Cannot reach server');
    expect(result).not.toContain('undefined');
  });
});

describe('isAuthenticationError', () => {
  describe('should detect authentication errors', () => {
    it('detects "re-authenticate" messages from createReauthError', () => {
      expect(
        isAuthenticationError(
          'Could not find OAuth token endpoint for https://mcp.notion.com/mcp. Please re-authenticate with: mcpc https://mcp.notion.com/mcp login'
        )
      ).toBe(true);
      expect(
        isAuthenticationError(
          'Token refresh failed. Please re-authenticate with: mcpc https://example.com login'
        )
      ).toBe(true);
    });

    it('detects "unauthorized" messages', () => {
      expect(isAuthenticationError('Unauthorized')).toBe(true);
      expect(isAuthenticationError('unauthorized access')).toBe(true);
    });

    it('detects "invalid_token" messages', () => {
      expect(isAuthenticationError('invalid_token')).toBe(true);
      expect(isAuthenticationError('Error: invalid_token')).toBe(true);
    });

    it('detects HTTP 401 and 403 status codes', () => {
      expect(isAuthenticationError('HTTP 401')).toBe(true);
      expect(isAuthenticationError('Error: 403 Forbidden')).toBe(true);
    });

    it('detects the SDK error after a refreshed token was rejected too (#395)', () => {
      // Thrown by the SDK transport when the retry after onUnauthorized() gets 401
      // again; the bridge must mark the session unauthorized on it.
      expect(isAuthenticationError('Server returned 401 after re-authentication')).toBe(true);
    });

    it('detects "authentication" keyword', () => {
      expect(isAuthenticationError('authentication failed')).toBe(true);
      expect(isAuthenticationError('Authentication required')).toBe(true);
    });

    it('detects "missing token" messages', () => {
      expect(isAuthenticationError('missing access token')).toBe(true);
      expect(isAuthenticationError('Missing token in request')).toBe(true);
    });
  });

  describe('should NOT detect as authentication error', () => {
    it('ignores generic errors', () => {
      expect(isAuthenticationError('Connection refused')).toBe(false);
      expect(isAuthenticationError('Network error')).toBe(false);
      expect(isAuthenticationError('Timeout')).toBe(false);
      expect(isAuthenticationError('Internal server error')).toBe(false);
    });

    it('ignores session-related errors', () => {
      expect(isAuthenticationError('session not found')).toBe(false);
      expect(isAuthenticationError('session expired')).toBe(false);
    });

    it('ignores empty or whitespace messages', () => {
      expect(isAuthenticationError('')).toBe(false);
      expect(isAuthenticationError('   ')).toBe(false);
    });

    it('ignores error codes that contain 401/403 as substrings', () => {
      // MCP JSON-RPC error codes like -32603 should not match
      expect(isAuthenticationError('MCP error -32603: Unknown tool')).toBe(false);
      // Port numbers or IDs containing 401/403 should not match
      expect(isAuthenticationError('connection to port 14013 failed')).toBe(false);
      expect(isAuthenticationError('request id 84017 timed out')).toBe(false);
    });
  });
});
