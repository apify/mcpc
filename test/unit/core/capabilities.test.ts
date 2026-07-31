/**
 * Unit tests for client capability declaration (src/core/capabilities.ts).
 */

import {
  buildClientCapabilities,
  CLIENT_CREDENTIALS_EXTENSION_KEY,
  ENTERPRISE_MANAGED_AUTH_EXTENSION_KEY,
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
    expect(caps.extensions).not.toHaveProperty(ENTERPRISE_MANAGED_AUTH_EXTENSION_KEY);
  });

  it('declares the enterprise-managed-authorization extension when requested', () => {
    expect(ENTERPRISE_MANAGED_AUTH_EXTENSION_KEY).toBe(
      'io.modelcontextprotocol/enterprise-managed-authorization'
    );
    const caps = buildClientCapabilities({ enterpriseManagedAuth: true }) as {
      extensions?: Record<string, unknown>;
    };
    expect(caps.extensions).toBeDefined();
    expect(caps.extensions).toHaveProperty(ENTERPRISE_MANAGED_AUTH_EXTENSION_KEY);
    expect(caps.extensions).not.toHaveProperty(CLIENT_CREDENTIALS_EXTENSION_KEY);
  });

  it('omits the enterprise-managed-authorization extension when false', () => {
    const caps = buildClientCapabilities({ enterpriseManagedAuth: false }) as {
      extensions?: Record<string, unknown>;
    };
    expect(caps.extensions).toBeUndefined();
  });
});
