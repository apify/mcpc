/**
 * Official MCP extensions, and where mcpc stands on each of them.
 *
 * Extensions are the modular part of MCP: identified by a reverse-DNS id, negotiated
 * through the `extensions` field of client and server capabilities, and always opt-in —
 * a feature is only used when both sides declare it. The official list mcpc tracks is
 * https://modelcontextprotocol.io/extensions/client-matrix.
 *
 * This module is the single source of truth for those identifiers: what mcpc declares to
 * servers (see `buildClientCapabilities`) and how a server's own declarations are reported
 * back to the user come from the same table, so the two can never drift apart.
 *
 * Deliberately dependency-free, like `protocol.ts`: the CLI imports it on every invocation
 * to render capabilities, and must not pull in the MCP SDK to do so.
 */

/** MCP Apps — interactive HTML interfaces rendered inline in a conversation. */
export const APPS_EXTENSION_KEY = 'io.modelcontextprotocol/ui';

/** OAuth client credentials — machine-to-machine auth without an interactive login. */
export const CLIENT_CREDENTIALS_EXTENSION_KEY = 'io.modelcontextprotocol/oauth-client-credentials';

/** Enterprise-managed authorization (SEP-990, ID-JAG) — access control via a corporate IdP. */
export const ENTERPRISE_MANAGED_AUTH_EXTENSION_KEY =
  'io.modelcontextprotocol/enterprise-managed-authorization';

/**
 * Skills over MCP — discovering skills and reading their instructions and supporting
 * files (`skills/list`, `skills/get`, and the optional `resources/directory/read`).
 *
 * Spec: https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/stable/skills.mdx
 */
export const SKILLS_EXTENSION_KEY = 'io.modelcontextprotocol/skills';

/** Tasks — asynchronous execution of long-running requests (core in 2025-11-25). */
export const TASKS_EXTENSION_KEY = 'io.modelcontextprotocol/tasks';

/**
 * Whether mcpc implements an extension:
 *
 * - `full` — the extension works end to end; `note` says through which commands.
 * - `none` — not implemented. mcpc never declares it, and says so when a server does.
 *
 * There is deliberately no half-way value: an extension mcpc speaks only in part is
 * something a server cannot rely on, so it is reported as unsupported until it isn't.
 */
export type ExtensionSupport = 'full' | 'none';

/** One official MCP extension, and mcpc's support for it. */
export interface McpExtension {
  /** Reverse-DNS identifier used as the key in `capabilities.extensions`. */
  id: string;
  /** Short human label, used when listing what a server advertises. */
  label: string;
  /** Whether mcpc implements the extension. */
  support: ExtensionSupport;
  /** One line on what works, or why nothing does. */
  note: string;
  /**
   * Whether mcpc declares the extension in its own client capabilities.
   *
   * Only extensions whose specification defines a *client-side* declaration belong here.
   * The skills extension, for instance, is declared by servers only — a client issues
   * `skills/list` and `skills/get` once it sees that declaration — so a client-side claim
   * would be invented, not reported, however completely mcpc implements it.
   */
  declaredByClient: boolean;
}

/**
 * Every official extension, whether or not mcpc implements it. Servers advertise
 * extensions on their own terms, so the unsupported entries earn their place: they let
 * mcpc name what a server offers instead of silently dropping it from the capability list.
 */
export const MCP_EXTENSIONS: readonly McpExtension[] = [
  {
    id: APPS_EXTENSION_KEY,
    label: 'MCP Apps',
    support: 'none',
    note: 'interactive HTML interfaces have no equivalent on a terminal',
    declaredByClient: false,
  },
  {
    id: CLIENT_CREDENTIALS_EXTENSION_KEY,
    label: 'OAuth client credentials',
    support: 'full',
    note: 'mcpc login <server> --grant client-credentials',
    declaredByClient: true,
  },
  {
    id: ENTERPRISE_MANAGED_AUTH_EXTENSION_KEY,
    label: 'enterprise-managed authorization',
    support: 'full',
    note: 'mcpc login <server> --grant id-jag',
    declaredByClient: true,
  },
  {
    id: SKILLS_EXTENSION_KEY,
    label: 'skills',
    support: 'full',
    note: 'mcpc @session skills-list / skills-get / resources-directory-read, on MCP 2026-07-28 connections',
    declaredByClient: false,
  },
  {
    id: TASKS_EXTENSION_KEY,
    label: 'async tasks',
    support: 'none',
    note: 'task commands work on 2025-11-25 servers, where tasks are part of the core protocol',
    declaredByClient: false,
  },
];

/** Look up an official extension by identifier. */
export function findMcpExtension(id: string): McpExtension | undefined {
  return MCP_EXTENSIONS.find((extension) => extension.id === id);
}

/**
 * The `extensions` map mcpc declares in its client capabilities: every extension whose
 * spec defines a client-side declaration and that mcpc implements.
 *
 * Declared unconditionally, because the map reports what this client *can* do, not what
 * the current connection happens to be doing — a server can only offer an extension to a
 * client it knows supports it, and mcpc's auth grants are chosen at `login` time, long
 * before any request goes out. Neither extension defines settings, so each maps to `{}`.
 */
export function clientExtensionDeclarations(): Record<string, Record<string, never>> {
  const declarations: Record<string, Record<string, never>> = {};
  for (const extension of MCP_EXTENSIONS) {
    if (extension.declaredByClient) declarations[extension.id] = {};
  }
  return declarations;
}
