/**
 * Shared fixtures and pure helpers for the E2E test servers.
 *
 * Two test servers serve this identical surface (tools, resources, prompts,
 * skills, OAuth endpoints):
 *   - index.ts    — MCP SDK v1, protocol 2025-11-25 ("legacy" era)
 *   - index-v2.ts — MCP SDK v2, protocol 2026-07-28 ("modern" era)
 *
 * Everything here is SDK-agnostic (plain objects and pure functions) so both
 * servers stay in lockstep: a fixture change automatically applies to both
 * columns of the protocol-version test matrix.
 */

import type http from 'http';

// Deterministic binary payload for test://static/binary (not valid UTF-8)
export const BINARY_PAYLOAD = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfc, 0xfd, 0xfe, 0xff]);

// Test data
export const TOOLS = [
  {
    name: 'echo',
    description: 'Returns the input message',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Message to echo' },
      },
      required: ['message'],
    },
    annotations: {
      title: 'Echo Tool',
      readOnlyHint: true,
    },
  },
  {
    name: 'add',
    description: 'Adds two numbers',
    inputSchema: {
      type: 'object' as const,
      properties: {
        a: { type: 'number', description: 'First number' },
        b: { type: 'number', description: 'Second number' },
      },
      required: ['a', 'b'],
    },
    annotations: {
      title: 'Add Numbers',
      readOnlyHint: true,
      idempotentHint: true,
    },
  },
  {
    name: 'fail',
    description: 'Always fails with an error',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Error message' },
      },
    },
  },
  {
    name: 'slow',
    description: 'Waits for specified milliseconds then returns',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ms: { type: 'number', description: 'Milliseconds to wait', default: 1000 },
      },
    },
  },
  {
    name: 'write-file',
    description: 'Simulates writing to a file (destructive)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['path', 'content'],
    },
    annotations: {
      title: 'Write File',
      destructiveHint: true,
    },
  },
  {
    name: 'slow-task',
    description: 'Long-running tool that supports async task execution',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ms: { type: 'number', description: 'Duration in milliseconds', default: 3000 },
        steps: { type: 'number', description: 'Number of progress steps', default: 3 },
      },
    },
  },
];

export const RESOURCES = [
  {
    uri: 'test://static/hello',
    name: 'Hello Resource',
    description: 'A static test resource',
    mimeType: 'text/plain',
  },
  {
    uri: 'test://static/json',
    name: 'JSON Resource',
    description: 'A JSON test resource',
    mimeType: 'application/json',
  },
  {
    uri: 'test://dynamic/time',
    name: 'Current Time',
    description: 'Returns current timestamp',
    mimeType: 'text/plain',
  },
  {
    uri: 'test://dynamic/counter',
    name: 'Counter Resource',
    description: 'Mutable counter for subscription tests (bump via /control/bump-counter)',
    mimeType: 'text/plain',
  },
  {
    uri: 'test://static/binary',
    name: 'Binary Resource',
    description: 'A small binary test resource (blob content)',
    mimeType: 'application/octet-stream',
  },
];

export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'test://file/{path}',
    name: 'File Template',
    description: 'Access files by path',
    mimeType: 'application/octet-stream',
  },
];

// Skills (experimental MCP extension: io.modelcontextprotocol/skills, SEP-2640)
// Each skill is served as one or more `skill://...` resources. The resource
// list always includes the skill file entries; the well-known
// `skill://index.json` is included only when the noIndex flag is unset, so
// tests can exercise both the index path and the resource-scan fallback.

const SKILL_GIT_BODY = `---
name: git-workflow
description: Helpers for everyday Git workflows
---

# Git workflow

Stash, commit, push. The usual.
`;

const SKILL_REFUNDS_BODY = `---
name: refunds
description: How acme processes refund requests
---

# Refunds

Acme's refund flow lives at \`acme/billing/refunds\`.
`;

// Extra non-SKILL.md file under a skill prefix — used to verify that the
// resource-scan fallback only picks up SKILL.md entries.
const SKILL_GIT_NOTES_BODY = `# Notes

Reference notes for the git-workflow skill.
`;

const SKILL_INDEX_BODY = JSON.stringify(
  {
    $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
    skills: [
      {
        name: 'git-workflow',
        type: 'skill-md',
        description: 'Helpers for everyday Git workflows',
        url: 'skill://git-workflow/SKILL.md',
      },
      {
        name: 'refunds',
        type: 'skill-md',
        description: 'How acme processes refund requests',
        url: 'skill://acme/billing/refunds/SKILL.md',
      },
      // SEP-2640 type: bundled skill delivered as a single archive resource.
      {
        name: 'big-skill',
        type: 'archive',
        description: 'A bundled skill delivered as .tar.gz',
        url: 'skill://big-skill/big-skill.tar.gz',
      },
      // Entry with unrecognized type — clients SHOULD skip it.
      {
        name: 'future-thing',
        type: 'something-not-in-spec',
        description: 'Reserved for a future spec version',
        url: 'skill://future-thing/SKILL.md',
      },
    ],
  },
  null,
  2
);

// Skill file resources always exposed when skills are enabled
const SKILL_FILE_RESOURCES = [
  {
    uri: 'skill://git-workflow/SKILL.md',
    name: 'git-workflow',
    description: 'Helpers for everyday Git workflows',
    mimeType: 'text/markdown',
  },
  {
    uri: 'skill://acme/billing/refunds/SKILL.md',
    name: 'refunds',
    description: 'How acme processes refund requests',
    mimeType: 'text/markdown',
  },
  {
    uri: 'skill://git-workflow/references/notes.md',
    name: 'git-workflow notes',
    description: 'Supporting notes for git-workflow',
    mimeType: 'text/markdown',
  },
];

const SKILL_INDEX_RESOURCE = {
  uri: 'skill://index.json',
  name: 'Skills index',
  description: 'Skills discovery index (SEP-2640)',
  mimeType: 'application/json',
};

/** Resource list entry shape shared by RESOURCES and the skills fixtures. */
export type TestResource = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
};

/**
 * Compute the effective skills resource list and content map for the given
 * env configuration (WITH_SKILLS / SKILLS_NO_INDEX).
 */
export function computeSkillsFixtures(
  withSkills: boolean,
  noIndex: boolean
): {
  resources: TestResource[];
  contents: Record<string, { mimeType: string; text: string }>;
} {
  if (!withSkills) {
    return { resources: [], contents: {} };
  }
  return {
    resources: noIndex
      ? [...SKILL_FILE_RESOURCES]
      : [SKILL_INDEX_RESOURCE, ...SKILL_FILE_RESOURCES],
    contents: {
      'skill://git-workflow/SKILL.md': { mimeType: 'text/markdown', text: SKILL_GIT_BODY },
      'skill://acme/billing/refunds/SKILL.md': {
        mimeType: 'text/markdown',
        text: SKILL_REFUNDS_BODY,
      },
      'skill://git-workflow/references/notes.md': {
        mimeType: 'text/markdown',
        text: SKILL_GIT_NOTES_BODY,
      },
      ...(noIndex
        ? {}
        : { 'skill://index.json': { mimeType: 'application/json', text: SKILL_INDEX_BODY } }),
    },
  };
}

export const PROMPTS = [
  {
    name: 'greeting',
    description: 'Generate a greeting message',
    arguments: [
      { name: 'name', description: 'Name to greet', required: true },
      { name: 'style', description: 'Greeting style (formal/casual)', required: false },
    ],
  },
  {
    name: 'summarize',
    description: 'Summarize text',
    arguments: [
      { name: 'text', description: 'Text to summarize', required: true },
      { name: 'maxLength', description: 'Maximum length', required: false },
    ],
  },
];

/**
 * Paginate a fixture list. pageSize <= 0 disables pagination.
 * The cursor is the stringified start index of the next page.
 */
export function paginate<T>(
  items: T[],
  cursor: string | undefined,
  pageSize: number
): { items: T[]; nextCursor?: string } {
  if (pageSize <= 0) {
    return { items };
  }

  const startIndex = cursor ? parseInt(cursor, 10) : 0;
  const endIndex = startIndex + pageSize;
  const pageItems = items.slice(startIndex, endIndex);

  // Only include nextCursor when there are more items (exactOptionalPropertyTypes compatibility)
  if (endIndex < items.length) {
    return { items: pageItems, nextCursor: String(endIndex) };
  }
  return { items: pageItems };
}

/** Read a request body to a string (for the form-encoded /token endpoint). */
export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** Text tool-call result shared by both servers. */
export type TestToolResult = {
  content: Array<{ type: 'text'; text: string }>;
};

/**
 * Execute one of the shared test tools (synchronous semantics only — the v1
 * server intercepts task-augmented `slow-task` calls before delegating here).
 * Throws on tool failure or unknown tool name, mirroring server-side errors.
 */
export async function callTestTool(
  name: string,
  args: Record<string, unknown> | undefined
): Promise<TestToolResult> {
  switch (name) {
    case 'echo':
      return {
        content: [{ type: 'text', text: String(args?.message || '') }],
      };

    case 'add': {
      const a = Number(args?.a || 0);
      const b = Number(args?.b || 0);
      return {
        content: [{ type: 'text', text: String(a + b) }],
      };
    }

    case 'fail':
      throw new Error(String(args?.message || 'Tool intentionally failed'));

    case 'slow': {
      const ms = Number(args?.ms || 1000);
      await new Promise((resolve) => setTimeout(resolve, ms));
      return {
        content: [{ type: 'text', text: `Waited ${ms}ms` }],
      };
    }

    case 'write-file':
      // Simulate write (don't actually write)
      return {
        content: [{ type: 'text', text: `Would write to ${args?.path}` }],
      };

    case 'slow-task': {
      // Synchronous execution (task-augmented execution is v1-server-only)
      const ms = Number(args?.ms || 3000);
      const steps = Number(args?.steps || 3);
      await new Promise((resolve) => setTimeout(resolve, ms));
      return {
        content: [{ type: 'text', text: `Completed ${steps} steps in ${ms}ms` }],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Resource read result contents shared by both servers. */
export type TestResourceContents = {
  contents: Array<
    | { uri: string; mimeType: string; text: string }
    | { uri: string; mimeType: string; blob: string }
  >;
};

/**
 * Read one of the shared test resources. Returns null when the URI is not a
 * known resource (each server maps that to its own not-found error).
 */
export function readTestResource(
  uri: string,
  counterValue: number,
  skillContents: Record<string, { mimeType: string; text: string }>
): TestResourceContents | null {
  if (uri === 'test://static/hello') {
    return {
      contents: [{ uri, mimeType: 'text/plain', text: 'Hello, World!' }],
    };
  }

  if (uri === 'test://static/json') {
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ test: true, value: 42 }),
        },
      ],
    };
  }

  if (uri === 'test://dynamic/time') {
    return {
      contents: [{ uri, mimeType: 'text/plain', text: new Date().toISOString() }],
    };
  }

  if (uri === 'test://dynamic/counter') {
    return {
      contents: [{ uri, mimeType: 'text/plain', text: `counter=${counterValue}` }],
    };
  }

  if (uri === 'test://static/binary') {
    return {
      contents: [
        {
          uri,
          mimeType: 'application/octet-stream',
          blob: BINARY_PAYLOAD.toString('base64'),
        },
      ],
    };
  }

  // Skill resources (SEP-2640). May include the well-known
  // skill://index.json plus per-skill SKILL.md files.
  const skillContent = skillContents[uri];
  if (skillContent) {
    return {
      contents: [{ uri, mimeType: skillContent.mimeType, text: skillContent.text }],
    };
  }

  return null;
}

/** Prompt result shared by both servers. */
export type TestPromptResult = {
  messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }>;
};

/**
 * Build one of the shared test prompts. Returns null when the prompt name is
 * unknown (each server maps that to its own not-found error).
 */
export function getTestPrompt(
  name: string,
  args: Record<string, string> | undefined
): TestPromptResult | null {
  if (name === 'greeting') {
    const userName = args?.name || 'World';
    const style = args?.style || 'casual';
    const greeting = style === 'formal' ? `Good day, ${userName}.` : `Hey ${userName}!`;

    return {
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: greeting },
        },
      ],
    };
  }

  if (name === 'summarize') {
    const text = args?.text || '';
    const maxLength = args?.maxLength ? parseInt(args.maxLength, 10) : 100;

    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Please summarize the following text in ${maxLength} characters or less:\n\n${text}`,
          },
        },
      ],
    };
  }

  return null;
}

/** Configuration for the OAuth client-credentials test endpoints. */
export interface OAuthEndpointsConfig {
  port: number;
  clientId: string;
  clientSecret: string;
  /** Serve /token but NOT the .well-known metadata (forces --token-endpoint). */
  noMetadata: boolean;
}

/**
 * Serve the OAuth client-credentials test endpoints (RFC 8414 metadata +
 * /token). Returns true when the request was handled. These endpoints must be
 * reachable without a Bearer token, so call this before any auth check.
 */
export async function handleOAuthEndpoints(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  config: OAuthEndpointsConfig
): Promise<boolean> {
  if (
    !config.noMetadata &&
    url.pathname === '/.well-known/oauth-authorization-server' &&
    req.method === 'GET'
  ) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        issuer: `http://localhost:${config.port}`,
        // authorization_endpoint + response_types_supported are required by RFC 8414;
        // the SDK validates the full metadata document even for the token-only path.
        authorization_endpoint: `http://localhost:${config.port}/authorize`,
        token_endpoint: `http://localhost:${config.port}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['client_credentials'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'private_key_jwt'],
      })
    );
    return true;
  }

  if (url.pathname === '/token' && req.method === 'POST') {
    const params = new URLSearchParams(await readBody(req));
    if (params.get('grant_type') !== 'client_credentials') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
      return true;
    }

    // Accept either client_secret_basic, client_secret_post, or private_key_jwt.
    // The JWT assertion's signature is not verified here — presence is enough to
    // prove the client (mcpc + SDK) built and sent it correctly.
    let authed = false;
    const authz = req.headers.authorization;
    if (authz?.startsWith('Basic ')) {
      const decoded = Buffer.from(authz.slice('Basic '.length), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const id = decodeURIComponent(decoded.slice(0, sep));
      const secret = decodeURIComponent(decoded.slice(sep + 1));
      authed = id === config.clientId && secret === config.clientSecret;
    } else if (params.get('client_assertion') && params.get('client_assertion_type')) {
      authed = true;
    } else if (params.get('client_id') && params.get('client_secret')) {
      authed =
        params.get('client_id') === config.clientId &&
        params.get('client_secret') === config.clientSecret;
    }

    if (!authed) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_client' }));
      return true;
    }

    const scope = params.get('scope');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        access_token: `cc-token-${Date.now()}`,
        token_type: 'Bearer',
        expires_in: 3600,
        ...(scope ? { scope } : {}),
      })
    );
    return true;
  }

  return false;
}
