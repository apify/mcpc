/**
 * Unit tests for client capability declaration (src/core/capabilities.ts).
 */

import {
  buildClientCapabilities,
  CLIENT_CREDENTIALS_EXTENSION_KEY,
} from '../../../src/core/capabilities.js';

describe('buildClientCapabilities', () => {
  it('always declares roots, sampling, and tasks', () => {
    const caps = buildClientCapabilities();
    expect(caps.roots).toEqual({ listChanged: true });
    expect(caps.sampling).toEqual({});
    expect(caps.tasks).toBeDefined();
  });

  it('omits the client-credentials extension by default', () => {
    const caps = buildClientCapabilities() as { extensions?: Record<string, unknown> };
    expect(caps.extensions).toBeUndefined();
  });

  it('omits the extension when clientCredentials is false', () => {
    const caps = buildClientCapabilities({ clientCredentials: false }) as {
      extensions?: Record<string, unknown>;
    };
    expect(caps.extensions).toBeUndefined();
  });

  it('declares the client-credentials extension when requested', () => {
    expect(CLIENT_CREDENTIALS_EXTENSION_KEY).toBe(
      'io.modelcontextprotocol/oauth-client-credentials'
    );
    const caps = buildClientCapabilities({ clientCredentials: true }) as {
      extensions?: Record<string, unknown>;
    };
    expect(caps.extensions).toBeDefined();
    expect(caps.extensions).toHaveProperty(CLIENT_CREDENTIALS_EXTENSION_KEY);
  });
});
