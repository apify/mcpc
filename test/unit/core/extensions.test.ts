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
  declaredExtensionSettings,
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
    expect(findMcpExtension(TASKS_EXTENSION_KEY)?.support).toBe('full');
    expect(findMcpExtension(APPS_EXTENSION_KEY)?.support).toBe('none');
    expect(findMcpExtension('com.example/not-an-extension')).toBeUndefined();
  });

  it('declares the two auth extensions and tasks, with no settings', () => {
    // A server may only hand a task to a client that declared the tasks extension on
    // that request, so the declaration has to ride along everywhere.
    expect(clientExtensionDeclarations()).toEqual({
      [CLIENT_CREDENTIALS_EXTENSION_KEY]: {},
      [ENTERPRISE_MANAGED_AUTH_EXTENSION_KEY]: {},
      [TASKS_EXTENSION_KEY]: {},
    });
  });

  describe('declaredExtensionSettings', () => {
    it('returns the settings of a declared extension', () => {
      const capabilities = { extensions: { [SKILLS_EXTENSION_KEY]: { directoryRead: true } } };
      expect(declaredExtensionSettings(capabilities, SKILLS_EXTENSION_KEY)).toEqual({
        directoryRead: true,
      });
    });

    it('tells an empty declaration apart from no declaration', () => {
      expect(
        declaredExtensionSettings(
          { extensions: { [TASKS_EXTENSION_KEY]: {} } },
          TASKS_EXTENSION_KEY
        )
      ).toEqual({});
      expect(declaredExtensionSettings({ extensions: {} }, TASKS_EXTENSION_KEY)).toBeUndefined();
      expect(declaredExtensionSettings({}, TASKS_EXTENSION_KEY)).toBeUndefined();
      expect(declaredExtensionSettings(undefined, TASKS_EXTENSION_KEY)).toBeUndefined();
    });

    it('treats a non-object declaration as an empty one', () => {
      // `extensions` values are objects per spec; a server sending `true` still declared it.
      expect(
        declaredExtensionSettings(
          { extensions: { [TASKS_EXTENSION_KEY]: true } },
          TASKS_EXTENSION_KEY
        )
      ).toEqual({});
    });
  });
});
