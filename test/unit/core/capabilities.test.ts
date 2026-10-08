/**
 * Unit tests for client capability declaration (src/core/capabilities.ts).
 */

import { buildClientCapabilities } from '../../../src/core/capabilities.js';
import {
  APPS_EXTENSION_KEY,
  CLIENT_CREDENTIALS_EXTENSION_KEY,
  ENTERPRISE_MANAGED_AUTH_EXTENSION_KEY,
  SKILLS_EXTENSION_KEY,
  TASKS_EXTENSION_KEY,
} from '../../../src/core/extensions.js';

describe('buildClientCapabilities', () => {
  it('declares tasks but not unimplemented capabilities (sampling, roots)', () => {
    const caps = buildClientCapabilities();
    expect(caps.tasks).toBeDefined();
    // mcpc has no LLM and registers no roots handler — declaring these would
    // invite server requests that can only fail with "Method not found".
    expect(caps.sampling).toBeUndefined();
    expect(caps.roots).toBeUndefined();
  });

  it('declares the auth and tasks extensions mcpc implements, on every connection', () => {
    // The map reports what this client can do, not what the connection happens to be
    // doing: a server can only offer an extension to a client it knows supports it, and
    // a 2026-07-28 server may only answer tools/call with a task when the request
    // declared the tasks extension.
    const caps = buildClientCapabilities() as { extensions?: Record<string, unknown> };
    expect(caps.extensions).toEqual({
      [CLIENT_CREDENTIALS_EXTENSION_KEY]: {},
      [ENTERPRISE_MANAGED_AUTH_EXTENSION_KEY]: {},
      [TASKS_EXTENSION_KEY]: {},
    });
  });

  it('does not declare extensions mcpc cannot back up', () => {
    const caps = buildClientCapabilities() as { extensions?: Record<string, unknown> };
    // MCP Apps is not implemented; skills is implemented but declared by servers only,
    // so a client claim would be invented.
    expect(caps.extensions).not.toHaveProperty(APPS_EXTENSION_KEY);
    expect(caps.extensions).not.toHaveProperty(SKILLS_EXTENSION_KEY);
  });
});
