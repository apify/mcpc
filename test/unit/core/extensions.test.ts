/**
 * Unit tests for the official MCP extension registry (src/core/extensions.ts).
 *
 * The identifiers are wire values: a typo makes mcpc silently miss a server's
 * declaration (or claim an extension nobody recognizes), so they are asserted
 * literally against https://modelcontextprotocol.io/extensions/client-matrix.
 */

import {
  APPS_EXTENSION_KEY,
  CLIENT_CREDENTIALS_EXTENSION_KEY,
  ENTERPRISE_MANAGED_AUTH_EXTENSION_KEY,
  MCP_EXTENSIONS,
  SKILLS_EXTENSION_KEY,
  TASKS_EXTENSION_KEY,
  clientExtensionDeclarations,
  findMcpExtension,
} from '../../../src/core/extensions.js';

describe('MCP extension registry', () => {
  it('uses the official extension identifiers', () => {
    expect(APPS_EXTENSION_KEY).toBe('io.modelcontextprotocol/ui');
    expect(CLIENT_CREDENTIALS_EXTENSION_KEY).toBe(
      'io.modelcontextprotocol/oauth-client-credentials'
    );
    expect(ENTERPRISE_MANAGED_AUTH_EXTENSION_KEY).toBe(
      'io.modelcontextprotocol/enterprise-managed-authorization'
    );
    expect(SKILLS_EXTENSION_KEY).toBe('io.modelcontextprotocol/skills');
    expect(TASKS_EXTENSION_KEY).toBe('io.modelcontextprotocol/tasks');
  });

  it('covers every official extension exactly once', () => {
    const ids = MCP_EXTENSIONS.map((extension) => extension.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        APPS_EXTENSION_KEY,
        CLIENT_CREDENTIALS_EXTENSION_KEY,
        ENTERPRISE_MANAGED_AUTH_EXTENSION_KEY,
        SKILLS_EXTENSION_KEY,
        TASKS_EXTENSION_KEY,
      ])
    );
  });

  it('gives every extension a label and a note', () => {
    for (const extension of MCP_EXTENSIONS) {
      expect(extension.label.length).toBeGreaterThan(0);
      expect(extension.note.length).toBeGreaterThan(0);
    }
  });

  it('only declares extensions mcpc implements', () => {
    for (const extension of MCP_EXTENSIONS) {
      if (extension.declaredByClient) expect(extension.support).toBe('full');
    }
  });

  it('does not declare skills, which the spec has servers declare', () => {
    // mcpc implements skills/list and skills/get in full; the extension still defines no
    // client-side declaration, so claiming one would be invented rather than reported.
    expect(findMcpExtension(SKILLS_EXTENSION_KEY)?.declaredByClient).toBe(false);
  });

  it('finds extensions by identifier and ignores unknown ones', () => {
    expect(findMcpExtension(SKILLS_EXTENSION_KEY)?.support).toBe('full');
    expect(findMcpExtension(APPS_EXTENSION_KEY)?.support).toBe('none');
    expect(findMcpExtension('com.example/not-an-extension')).toBeUndefined();
  });

  it('declares the two auth extensions, with no settings', () => {
    expect(clientExtensionDeclarations()).toEqual({
      [CLIENT_CREDENTIALS_EXTENSION_KEY]: {},
      [ENTERPRISE_MANAGED_AUTH_EXTENSION_KEY]: {},
    });
  });
});
