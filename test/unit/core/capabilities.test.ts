/**
 * Unit tests for client capability declaration (src/core/capabilities.ts).
 */

import {
  buildClientCapabilities,
  CLIENT_CREDENTIALS_EXTENSION_KEY,
} from '../../../src/core/capabilities.js';

describe('buildClientCapabilities', () => {
  it('declares tasks but not unimplemented capabilities (sampling, roots)', () => {
    const caps = buildClientCapabilities();
    expect(caps.tasks).toBeDefined();
    // mcpc has no LLM and registers no roots handler — declaring these would
    // invite server requests that can only fail with "Method not found".
    expect(caps.sampling).toBeUndefined();
    expect(caps.roots).toBeUndefined();
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
