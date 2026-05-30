#!/usr/bin/env npx ts-node
/**
 * Configurable MCP test server for E2E testing
 *
 * Environment variables:
 *   PORT - HTTP port (default: 13456)
 *   PAGINATION_SIZE - items per page, 0 = no pagination (default: 0)
 *   LATENCY_MS - artificial latency in ms (default: 0)
 *   REQUIRE_AUTH - require Authorization header (default: false)
 *   NO_TOOLS - disable tools capability (default: false)
 *   NO_RESOURCES - disable resources capability (default: false)
 *   NO_PROMPTS - disable prompts capability (default: false)
 *   WITH_SKILLS - enable the io.modelcontextprotocol/skills extension and
 *     expose skill:// resources (default: false; opt-in to avoid skewing
 *     resource counts in non-skills tests)
 *   SKILLS_NO_INDEX - serve skill files but no skill://index.json (default: false,
 *     used to exercise the resource-scan fallback path; only meaningful when
 *     WITH_SKILLS=true)
 *
 * Control endpoints (for test manipulation):
 *   GET  /health - health check
 *   GET  /control/get-deleted-sessions - list session IDs that received DELETE
 *   GET  /control/get-active-sessions - list active MCP session IDs
 *   POST /control/fail-next?count=N - fail next N MCP requests
 *   POST /control/expire-session - expire current session
 *   POST /control/reset - reset all control state
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourceTemplatesRequestSchema,
  GetTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  ListTasksRequestSchema,
  CancelTaskRequestSchema,
  type Task,
  type Result,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import http from 'http';

// Configuration from environment
const PORT = parseInt(process.env.PORT || '13456', 10);
const PAGINATION_SIZE = parseInt(process.env.PAGINATION_SIZE || '0', 10);
const LATENCY_MS = parseInt(process.env.LATENCY_MS || '0', 10);
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true';
const NO_TOOLS = process.env.NO_TOOLS === 'true';
const NO_RESOURCES = process.env.NO_RESOURCES === 'true';
const NO_PROMPTS = process.env.NO_PROMPTS === 'true';
const WITH_SKILLS = process.env.WITH_SKILLS === 'true';
const SKILLS_NO_INDEX = process.env.SKILLS_NO_INDEX === 'true';

// Control state (manipulated via /control/* endpoints)
let failNextCount = 0;
let sessionExpired = false;
const deletedSessions: string[] = [];

// Test data
const TOOLS = [
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
    execution: {
      taskSupport: 'optional' as const,
    },
  },
];

const RESOURCES = [
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
];

const RESOURCE_TEMPLATES = [
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
// `skill://index.json` is included only when SKILLS_NO_INDEX is unset, so
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

// Skill file resources always exposed (when NO_SKILLS is unset)
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

// Compute the effective skills resource list and content map at startup.
const SKILLS_RESOURCES: Array<{
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}> = !WITH_SKILLS
  ? []
  : SKILLS_NO_INDEX
    ? [...SKILL_FILE_RESOURCES]
    : [SKILL_INDEX_RESOURCE, ...SKILL_FILE_RESOURCES];

const SKILL_CONTENTS: Record<string, { mimeType: string; text: string }> = !WITH_SKILLS
  ? {}
  : {
      'skill://git-workflow/SKILL.md': { mimeType: 'text/markdown', text: SKILL_GIT_BODY },
      'skill://acme/billing/refunds/SKILL.md': {
        mimeType: 'text/markdown',
        text: SKILL_REFUNDS_BODY,
      },
      'skill://git-workflow/references/notes.md': {
        mimeType: 'text/markdown',
        text: SKILL_GIT_NOTES_BODY,
      },
      ...(SKILLS_NO_INDEX
        ? {}
        : { 'skill://index.json': { mimeType: 'application/json', text: SKILL_INDEX_BODY } }),
    };

const PROMPTS = [
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

// Helper for pagination
function paginate<T>(items: T[], cursor?: string): { items: T[]; nextCursor?: string } {
  if (PAGINATION_SIZE <= 0) {
    return { items };
  }

  const startIndex = cursor ? parseInt(cursor, 10) : 0;
  const endIndex = startIndex + PAGINATION_SIZE;
  const pageItems = items.slice(startIndex, endIndex);

  // Only include nextCursor when there are more items (exactOptionalPropertyTypes compatibility)
  if (endIndex < items.length) {
    return { items: pageItems, nextCursor: String(endIndex) };
  }
  return { items: pageItems };
}

// Helper for artificial latency
async function maybeDelay(): Promise<void> {
  if (LATENCY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
  }
}

// Helper to check if we should fail
function shouldFail(): boolean {
  if (failNextCount > 0) {
    failNextCount--;
    return true;
  }
  return false;
}

// Task store for async tool execution
interface TaskEntry {
  task: Task;
  result?: Result;
  abortController?: AbortController;
}
const taskStore = new Map<string, TaskEntry>();

// Active MCP server instances, keyed by session ID
const mcpServers = new Map<string, Server>();

// Create a new MCP server instance (one per session)
function createMcpServer(): Server {
  // Build capabilities based on env config
  const capabilities: Record<string, unknown> = {
    logging: {},
  };
  if (!NO_TOOLS) {
    capabilities.tools = { listChanged: true };
    capabilities.tasks = {
      list: {},
      cancel: {},
      requests: { tools: { call: {} } },
    };
  }
  if (!NO_RESOURCES) {
    capabilities.resources = { subscribe: true, listChanged: true };
  }
  if (!NO_PROMPTS) {
    capabilities.prompts = { listChanged: true };
  }
  // Advertise the experimental skills extension when skill resources are exposed.
  // SEP-2640 specifies `capabilities.extensions`, but current MCP SDKs strip
  // unknown capability fields. We also publish under `capabilities.experimental`
  // (the standard SDK-preserved escape hatch) so clients can detect the
  // extension today regardless of SDK version.
  if (WITH_SKILLS && !NO_RESOURCES) {
    const SKILLS_KEY = 'io.modelcontextprotocol/skills';
    capabilities.extensions = {
      ...((capabilities.extensions as Record<string, unknown>) || {}),
      [SKILLS_KEY]: {},
    };
    capabilities.experimental = {
      ...((capabilities.experimental as Record<string, unknown>) || {}),
      [SKILLS_KEY]: {},
    };
  }

  const server = new Server(
    {
      name: 'e2e-test-server',
      version: '1.0.0',
    },
    {
      capabilities,
      instructions:
        'E2E test server for mcpc. Provides sample tools, resources, and prompts for testing.',
    }
  );

  // Tools (only register handlers if capability is enabled)
  if (!NO_TOOLS) {
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      const { items, nextCursor } = paginate(TOOLS, request.params?.cursor);
      return { tools: items, nextCursor };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      const { name, arguments: args } = request.params;

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
          const ms = Number(args?.ms || 3000);
          const steps = Number(args?.steps || 3);
          const taskParam = request.params.task;

          if (taskParam) {
            // Task-augmented execution: create task and run in background
            const taskId = randomUUID();
            const now = new Date().toISOString();
            const task: Task = {
              taskId,
              status: 'working',
              ttl: null,
              createdAt: now,
              lastUpdatedAt: now,
              statusMessage: 'Starting...',
            };
            const abortController = new AbortController();
            taskStore.set(taskId, { task, abortController });

            // Run the work in background
            void (async () => {
              const stepDuration = ms / steps;
              for (let i = 1; i <= steps; i++) {
                await new Promise((resolve) => setTimeout(resolve, stepDuration));
                if (abortController.signal.aborted) {
                  return;
                }
                const entry = taskStore.get(taskId);
                if (entry) {
                  entry.task.status = i < steps ? 'working' : 'completed';
                  entry.task.statusMessage =
                    i < steps ? `Processing step ${i}/${steps}` : `Done (${steps} steps)`;
                  entry.task.lastUpdatedAt = new Date().toISOString();
                  if (i === steps) {
                    entry.result = {
                      content: [
                        {
                          type: 'text',
                          text: `Completed ${steps} steps in ${ms}ms`,
                        },
                      ],
                    };
                  }
                }
              }
            })();

            // Return CreateTaskResult immediately
            return { task } as unknown as { content: { type: string; text: string }[] };
          }

          // Synchronous execution (no task param)
          await new Promise((resolve) => setTimeout(resolve, ms));
          return {
            content: [{ type: 'text', text: `Completed ${steps} steps in ${ms}ms` }],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });

    // Task management handlers
    server.setRequestHandler(GetTaskRequestSchema, async (request) => {
      const { taskId } = request.params;
      const entry = taskStore.get(taskId);
      if (!entry) {
        throw new Error(`Task not found: ${taskId}`);
      }
      return entry.task;
    });

    server.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {
      const { taskId } = request.params;
      const entry = taskStore.get(taskId);
      if (!entry) {
        throw new Error(`Task not found: ${taskId}`);
      }
      // Block until task reaches terminal state
      while (entry.task.status === 'working' || entry.task.status === 'input_required') {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (entry.result) {
        return entry.result;
      }
      throw new Error(`Task ${taskId} has no result (status: ${entry.task.status})`);
    });

    server.setRequestHandler(ListTasksRequestSchema, async () => {
      const allTasks = Array.from(taskStore.values()).map((e) => e.task);
      return { tasks: allTasks };
    });

    server.setRequestHandler(CancelTaskRequestSchema, async (request) => {
      const { taskId } = request.params;
      const entry = taskStore.get(taskId);
      if (!entry) {
        throw new Error(`Task not found: ${taskId}`);
      }
      if (
        entry.task.status === 'completed' ||
        entry.task.status === 'failed' ||
        entry.task.status === 'cancelled'
      ) {
        throw new Error(`Cannot cancel task in terminal state: ${entry.task.status}`);
      }
      entry.task.status = 'cancelled';
      entry.task.lastUpdatedAt = new Date().toISOString();
      entry.abortController?.abort();
      return entry.task;
    });
  } // end if (!NO_TOOLS)

  // Resources (only register handlers if capability is enabled)
  if (!NO_RESOURCES) {
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      // Combine standard test resources with skill resources (when enabled)
      // so listResources can drive the skills resource-scan fallback path.
      const all = [...RESOURCES, ...SKILLS_RESOURCES];
      const { items, nextCursor } = paginate(all, request.params?.cursor);
      return { resources: items, nextCursor };
    });

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      const { items, nextCursor } = paginate(RESOURCE_TEMPLATES, request.params?.cursor);
      return { resourceTemplates: items, nextCursor };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      const { uri } = request.params;

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

      // Skill resources (SEP-2640). May include the well-known
      // skill://index.json plus per-skill SKILL.md files.
      const skillContent = SKILL_CONTENTS[uri];
      if (skillContent) {
        return {
          contents: [{ uri, mimeType: skillContent.mimeType, text: skillContent.text }],
        };
      }

      throw new Error(`Resource not found: ${uri}`);
    });
  } // end if (!NO_RESOURCES)

  // Prompts (only register handlers if capability is enabled)
  if (!NO_PROMPTS) {
    server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      const { items, nextCursor } = paginate(PROMPTS, request.params?.cursor);
      return { prompts: items, nextCursor };
    });

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      const { name, arguments: args } = request.params;

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

      throw new Error(`Prompt not found: ${name}`);
    });
  } // end if (!NO_PROMPTS)

  return server;
}

// Create HTTP server with MCP transport and control endpoints
async function main() {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);

    // Health check
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Control endpoints
    if (url.pathname.startsWith('/control/')) {
      const action = url.pathname.slice('/control/'.length);

      // GET endpoints
      if (req.method === 'GET') {
        if (action === 'get-deleted-sessions') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ deletedSessions }));
          return;
        }
        if (action === 'get-active-sessions') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ activeSessions: Array.from(transports.keys()) }));
          return;
        }
        res.writeHead(404);
        res.end('Unknown control action');
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method not allowed');
        return;
      }

      switch (action) {
        case 'fail-next': {
          const count = parseInt(url.searchParams.get('count') || '1', 10);
          failNextCount = count;
          res.writeHead(200);
          res.end(`Will fail next ${count} requests`);
          return;
        }

        case 'expire-session':
          sessionExpired = true;
          res.writeHead(200);
          res.end('Session marked as expired');
          return;

        case 'reset':
          failNextCount = 0;
          sessionExpired = false;
          deletedSessions.length = 0;
          res.writeHead(200);
          res.end('State reset');
          return;

        case 'notify-tools-changed':
          await Promise.all([...mcpServers.values()].map((s) => s.sendToolListChanged()));
          res.writeHead(200);
          res.end('Sent tools/list_changed notification');
          return;

        case 'notify-prompts-changed':
          await Promise.all([...mcpServers.values()].map((s) => s.sendPromptListChanged()));
          res.writeHead(200);
          res.end('Sent prompts/list_changed notification');
          return;

        case 'notify-resources-changed':
          await Promise.all([...mcpServers.values()].map((s) => s.sendResourceListChanged()));
          res.writeHead(200);
          res.end('Sent resources/list_changed notification');
          return;

        default:
          res.writeHead(404);
          res.end('Unknown control action');
          return;
      }
    }

    // Auth check
    if (REQUIRE_AUTH) {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    // Session expiration check
    if (sessionExpired) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session expired' }));
      return;
    }

    // MCP endpoint
    if (url.pathname === '/' || url.pathname === '/mcp') {
      // Handle MCP requests via StreamableHTTPServerTransport
      const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;

      // Handle DELETE first (session termination) - must check before regular session lookup
      if (req.method === 'DELETE') {
        if (mcpSessionId && transports.has(mcpSessionId)) {
          const oldTransport = transports.get(mcpSessionId)!;
          await oldTransport.close();
          transports.delete(mcpSessionId);
          mcpServers.delete(mcpSessionId);
          deletedSessions.push(mcpSessionId);
        }
        res.writeHead(200);
        res.end();
        return;
      }

      let transport: StreamableHTTPServerTransport;

      if (mcpSessionId && transports.has(mcpSessionId)) {
        transport = transports.get(mcpSessionId)!;
      } else if (req.method === 'POST' && !mcpSessionId) {
        // New session - create a fresh Server + transport per connection
        const sessionServer = createMcpServer();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () =>
            `e2e-session-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          onsessioninitialized: (newSessionId) => {
            transports.set(newSessionId, transport);
            mcpServers.set(newSessionId, sessionServer);
          },
        });

        // Connect the fresh server instance to the transport
        // Type assertion needed due to exactOptionalPropertyTypes incompatibility with MCP SDK
        // @ts-ignore
        await sessionServer.connect(transport as Parameters<typeof sessionServer.connect>[0]);
      } else if (mcpSessionId && !transports.has(mcpSessionId)) {
        // Session ID provided but not found - per MCP spec, return 404
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Session ID ${mcpSessionId} not found` }));
        return;
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
        return;
      }

      // Let transport handle the request
      await transport.handleRequest(req, res);
      return;
    }

    // 404 for unknown paths
    res.writeHead(404);
    res.end('Not found');
  });

  httpServer.listen(PORT, () => {
    console.log(`E2E test server running on http://localhost:${PORT}`);
    console.log(
      `  Pagination: ${PAGINATION_SIZE > 0 ? `${PAGINATION_SIZE} items/page` : 'disabled'}`
    );
    console.log(`  Latency: ${LATENCY_MS}ms`);
    console.log(`  Auth required: ${REQUIRE_AUTH}`);
    if (NO_TOOLS) console.log(`  Tools: DISABLED`);
    if (NO_RESOURCES) console.log(`  Resources: DISABLED`);
    if (NO_PROMPTS) console.log(`  Prompts: DISABLED`);
    if (WITH_SKILLS) {
      console.log(`  Skills: ENABLED${SKILLS_NO_INDEX ? ' (index OFF, fallback only)' : ''}`);
    }
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('Shutting down...');
    httpServer.close();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('Shutting down...');
    httpServer.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
