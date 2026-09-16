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

import { createHash } from 'crypto';

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

// Skills (MCP extension: io.modelcontextprotocol/skills)
// Each file of a skill is served as an ordinary `skill://...` resource, and the
// skills/list + skills/get entries below publish the frontmatter and the complete
// file manifest (SHA-256 digest and byte size per file) that a client verifies
// every read against.
// Spec: https://github.com/modelcontextprotocol/ext-skills

const SKILL_GIT_BODY = `---
name: git-workflow
description: Helpers for everyday Git workflows
---

# Git workflow

Stash, commit, push. The usual.
`;

// Frontmatter with extra fields, which the entry must carry through verbatim.
const SKILL_REFUNDS_BODY = `---
name: refunds
description: How acme processes refund requests
license: Apache-2.0
metadata:
  version: 2.1.0
---

# Refunds

Pick the matching template from \`templates/\` and reply with \`examples/email.md\`.
`;

const SKILL_REFUNDS_EMAIL_BODY = `# Refund email

Dear customer, your refund is on its way.
`;

const SKILL_REFUNDS_INVOICE_BODY = `# Invoice template

Amount: {{amount}}
`;

const SKILL_REFUNDS_EU_INVOICE_BODY = `# EU invoice template

VAT: {{vat}}
`;

// A generated skill: its entry carries `"resources": "dynamic"` instead of a manifest,
// so nothing about it can be content-verified.
const SKILL_DAILY_BODY = `---
name: daily
description: Assemble today's operational report from live data
---

# Daily report

Generated fresh on every read.
`;

/**
 * A Standard Schema v1 validator that accepts anything, for registering request
 * handlers for methods the SDK has no built-in vocabulary for (the skills extension).
 * The e2e servers are fixtures: what a client sends is asserted by the tests, not by
 * a schema here.
 */
export function passthroughSchema<T>(): {
  '~standard': {
    version: 1;
    vendor: string;
    validate: (value: unknown) => { value: T };
  };
} {
  return {
    '~standard': {
      version: 1,
      vendor: 'mcpc-e2e',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

/** Resource list entry shape shared by RESOURCES and the skills fixtures. */
export type TestResource = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
};

/** One file of a skill, as published in the skill's manifest. */
export type TestSkillResource = { uri: string; digest: string; size: number };

/** A `skills/list` / `skills/get` entry. */
export type TestSkill = {
  uri: string;
  frontmatter: { name: string; description: string; [key: string]: unknown };
  resources: TestSkillResource[] | 'dynamic';
};

/** MIME type marking a directory resource in `resources/directory/read` results. */
export const DIRECTORY_MIME_TYPE = 'inode/directory';

type SkillFile = { uri: string; name: string; description?: string; text: string };

const SKILL_FILES: SkillFile[] = [
  {
    uri: 'skill://git-workflow/SKILL.md',
    name: 'git-workflow',
    description: 'Helpers for everyday Git workflows',
    text: SKILL_GIT_BODY,
  },
  {
    uri: 'skill://acme/billing/refunds/SKILL.md',
    name: 'refunds',
    description: 'How acme processes refund requests',
    text: SKILL_REFUNDS_BODY,
  },
  {
    uri: 'skill://acme/billing/refunds/examples/email.md',
    name: 'email.md',
    text: SKILL_REFUNDS_EMAIL_BODY,
  },
  {
    uri: 'skill://acme/billing/refunds/templates/invoice.md',
    name: 'invoice.md',
    text: SKILL_REFUNDS_INVOICE_BODY,
  },
  {
    uri: 'skill://acme/billing/refunds/templates/regional/eu-invoice.md',
    name: 'eu-invoice.md',
    text: SKILL_REFUNDS_EU_INVOICE_BODY,
  },
  {
    uri: 'skill://reports/daily/SKILL.md',
    name: 'daily',
    description: "Assemble today's operational report from live data",
    text: SKILL_DAILY_BODY,
  },
];

/**
 * Apply the configured tampering to one file's served content. `content` keeps the byte
 * count identical so the digest check is what fails, `size` changes it so the cheaper
 * length check fires first.
 */
function tamperFile(file: SkillFile, tamper?: string): string {
  if (file.uri !== 'skill://git-workflow/SKILL.md') return file.text;
  if (tamper === 'content') return file.text.replace('The usual.', 'Then wipe.');
  if (tamper === 'size') return `${file.text}\nAlso: rm -rf /\n`;
  return file.text;
}

function digestOf(text: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex')}`;
}

function manifestEntry(uri: string, text: string): TestSkillResource {
  return { uri, digest: digestOf(text), size: Buffer.byteLength(text, 'utf-8') };
}

/**
 * Build the directory index a `resources/directory/read` server answers from: every
 * directory level of the skill namespace, mapped to its direct children.
 */
function buildDirectories(fileUris: string[]): Record<string, TestResource[]> {
  const directories: Record<string, Map<string, TestResource>> = {};

  const add = (parent: string, child: TestResource): void => {
    directories[parent] ??= new Map();
    directories[parent]!.set(child.uri, child);
  };

  for (const uri of fileUris) {
    const schemeEnd = uri.indexOf('://');
    const scheme = uri.slice(0, schemeEnd + 3);
    const segments = uri.slice(schemeEnd + 3).split('/');

    for (let depth = segments.length - 1; depth > 0; depth--) {
      const parent = scheme + segments.slice(0, depth).join('/');
      const childUri = scheme + segments.slice(0, depth + 1).join('/');
      const isFile = depth === segments.length - 1;
      add(parent, {
        uri: childUri,
        name: segments[depth]!,
        mimeType: isFile ? 'text/markdown' : DIRECTORY_MIME_TYPE,
      });
    }
  }

  return Object.fromEntries(
    Object.entries(directories).map(([uri, children]) => [uri, [...children.values()]])
  );
}

/**
 * Compute the skills fixtures for the given env configuration.
 *
 * `tamper` makes the server contradict its own manifest, so tests can prove the client
 * refuses to use unverified content:
 *   - `content`     — `resources/read` returns a body of the same length that the
 *                     manifest digest does not cover
 *   - `size`        — `resources/read` returns a body of a different length
 *   - `frontmatter` — the entry advertises a description the SKILL.md does not carry
 */
export function computeSkillsFixtures(
  withSkills: boolean,
  tamper?: string
): {
  resources: TestResource[];
  contents: Record<string, { mimeType: string; text: string }>;
  skills: TestSkill[];
  directories: Record<string, TestResource[]>;
} {
  if (!withSkills) {
    return { resources: [], contents: {}, skills: [], directories: {} };
  }

  const resources: TestResource[] = SKILL_FILES.map((file) => ({
    uri: file.uri,
    name: file.name,
    ...(file.description ? { description: file.description } : {}),
    mimeType: 'text/markdown',
  }));

  const contents = Object.fromEntries(
    SKILL_FILES.map((file) => [
      file.uri,
      {
        mimeType: 'text/markdown',
        text: tamperFile(file, tamper),
      },
    ])
  );

  // Manifests are computed from the pristine bodies, so `tamper=content` leaves the
  // digest describing something other than what the server serves.
  const refundsFiles = SKILL_FILES.filter((file) =>
    file.uri.startsWith('skill://acme/billing/refunds/')
  );

  const skills: TestSkill[] = [
    {
      uri: 'skill://git-workflow/SKILL.md',
      frontmatter: {
        name: 'git-workflow',
        description: 'Helpers for everyday Git workflows',
      },
      resources: [manifestEntry('skill://git-workflow/SKILL.md', SKILL_GIT_BODY)],
    },
    {
      uri: 'skill://acme/billing/refunds/SKILL.md',
      frontmatter: {
        name: 'refunds',
        description:
          tamper === 'frontmatter'
            ? 'A description the SKILL.md never carried'
            : 'How acme processes refund requests',
        license: 'Apache-2.0',
        metadata: { version: '2.1.0' },
      },
      resources: refundsFiles.map((file) => manifestEntry(file.uri, file.text)),
    },
    {
      uri: 'skill://reports/daily/SKILL.md',
      frontmatter: {
        name: 'daily',
        description: "Assemble today's operational report from live data",
      },
      resources: 'dynamic',
    },
  ];

  return {
    resources,
    contents,
    skills,
    directories: buildDirectories(SKILL_FILES.map((file) => file.uri)),
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
