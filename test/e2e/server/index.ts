#!/usr/bin/env npx ts-node
/**
 * Configurable MCP test server for E2E testing (MCP SDK v1, protocol
 * 2025-11-25 — the "legacy" era column of the protocol-version test matrix;
 * see index-v2.ts for the 2026-07-28 counterpart serving the same surface).
 *
 * Environment variables:
 *   PORT - HTTP port (default: 13456)
 *   PAGINATION_SIZE - items per page, 0 = no pagination (default: 0)
 *   LATENCY_MS - artificial latency in ms (default: 0)
 *   REQUIRE_AUTH - require Authorization header (default: false)
 *   NO_TOOLS - disable tools capability (default: false)
 *   NO_TASKS - serve tools but withhold the tasks capability, so --task/--detach
 *     must be refused rather than silently run synchronously (default: false)
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
 *   GET  /control/get-subscriptions - resource URIs subscribed per session
 *   POST /control/fail-next?count=N - fail next N MCP requests
 *   POST /control/expire-session - expire current session
 *   POST /control/bump-counter - increment test://dynamic/counter + notify subscribers
 *   POST /control/notify-resource-updated?uri=U - send resources/updated to all sessions
 *   POST /control/reset - reset all control state
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
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
import {
  TOOLS,
  RESOURCES,
  RESOURCE_TEMPLATES,
  PROMPTS,
  computeSkillsFixtures,
  paginate,
  callTestTool,
  readTestResource,
  getTestPrompt,
  handleOAuthEndpoints,
} from './fixtures.js';

// Configuration from environment
const PORT = parseInt(process.env.PORT || '13456', 10);
const PAGINATION_SIZE = parseInt(process.env.PAGINATION_SIZE || '0', 10);
const LATENCY_MS = parseInt(process.env.LATENCY_MS || '0', 10);
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true';
const NO_TOOLS = process.env.NO_TOOLS === 'true';
// Serve tools but withhold the tasks capability, so `--task`/`--detach` must refuse
const NO_TASKS = process.env.NO_TASKS === 'true';
const NO_RESOURCES = process.env.NO_RESOURCES === 'true';
const NO_PROMPTS = process.env.NO_PROMPTS === 'true';
const WITH_SKILLS = process.env.WITH_SKILLS === 'true';
const SKILLS_NO_INDEX = process.env.SKILLS_NO_INDEX === 'true';
// OAuth client-credentials grant test endpoints (metadata + /token). Opt-in so
// other suites are unaffected. Expected credentials default to test values.
const WITH_OAUTH = process.env.WITH_OAUTH === 'true';
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'test-client';
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || 's3cr3t';
// When true, serve /token but NOT the .well-known metadata, so discovery fails and
// only an explicit --token-endpoint can locate the token endpoint.
const OAUTH_NO_METADATA = process.env.OAUTH_NO_METADATA === 'true';

// Control state (manipulated via /control/* endpoints)
let failNextCount = 0;
let sessionExpired = false;
const deletedSessions: string[] = [];

// Mutable counter resource state (bumped via /control/bump-counter)
let counterValue = 0;

// Resource URIs subscribed per MCP server instance (resources/subscribe)
const serverSubscriptions = new WeakMap<Server, Set<string>>();

// The task-augmented slow-task tool advertises optional task support
// (2025-11-25 experimental tasks — v1 server only; tasks moved to an
// extension in 2026-07-28 that the v2 SDK does not implement yet).
const V1_TOOLS = TOOLS.map((tool) =>
  tool.name === 'slow-task' ? { ...tool, execution: { taskSupport: 'optional' as const } } : tool
);

// Compute the effective skills resource list and content map at startup.
const { resources: SKILLS_RESOURCES, contents: SKILL_CONTENTS } = computeSkillsFixtures(
  WITH_SKILLS,
  SKILLS_NO_INDEX
);

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
    if (!NO_TASKS) {
      capabilities.tasks = {
        list: {},
        cancel: {},
        requests: { tools: { call: {} } },
      };
    }
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
      description: 'A fake MCP server that exists only to exercise the mcpc CLI.',
      websiteUrl: 'https://example.com/e2e-test-server',
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

      const { items, nextCursor } = paginate(V1_TOOLS, request.params?.cursor, PAGINATION_SIZE);
      return { tools: items, nextCursor };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      const { name, arguments: args } = request.params;

      if (name === 'slow-task' && request.params.task) {
        // Task-augmented execution: create task and run in background
        const ms = Number(args?.ms || 3000);
        const steps = Number(args?.steps || 3);
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

      return callTestTool(name, args);
    });

    // Task management handlers. Skipped under NO_TASKS: the SDK refuses to register a
    // handler for a capability the server did not declare.
    if (!NO_TASKS) {
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
    } // end if (!NO_TASKS)
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
      const { items, nextCursor } = paginate(all, request.params?.cursor, PAGINATION_SIZE);
      return { resources: items, nextCursor };
    });

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      const { items, nextCursor } = paginate(
        RESOURCE_TEMPLATES,
        request.params?.cursor,
        PAGINATION_SIZE
      );
      return { resourceTemplates: items, nextCursor };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      const { uri } = request.params;
      const contents = readTestResource(uri, counterValue, SKILL_CONTENTS);
      if (!contents) {
        throw new Error(`Resource not found: ${uri}`);
      }
      return contents;
    });

    // Resource subscriptions (resources/subscribe, resources/unsubscribe).
    // Subscribed URIs are tracked per server instance so control endpoints can
    // send notifications/resources/updated to the right sessions.
    const subscribedUris = new Set<string>();
    server.setRequestHandler(SubscribeRequestSchema, async (request) => {
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      const { uri } = request.params;
      const known = [...RESOURCES, ...SKILLS_RESOURCES].some((r) => r.uri === uri);
      if (!known) {
        throw new Error(`Resource not found: ${uri}`);
      }
      subscribedUris.add(uri);
      return {};
    });

    server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      subscribedUris.delete(request.params.uri);
      return {};
    });
    serverSubscriptions.set(server, subscribedUris);
  } // end if (!NO_RESOURCES)

  // Prompts (only register handlers if capability is enabled)
  if (!NO_PROMPTS) {
    server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      const { items, nextCursor } = paginate(PROMPTS, request.params?.cursor, PAGINATION_SIZE);
      return { prompts: items, nextCursor };
    });

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      const { name, arguments: args } = request.params;
      const prompt = getTestPrompt(name, args);
      if (!prompt) {
        throw new Error(`Prompt not found: ${name}`);
      }
      return prompt;
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
        if (action === 'get-subscriptions') {
          // Resource URIs subscribed per active MCP session
          const subscriptions: Record<string, string[]> = {};
          for (const [sessionId, server] of mcpServers) {
            subscriptions[sessionId] = Array.from(serverSubscriptions.get(server) ?? []);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ subscriptions }));
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
          counterValue = 0;
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

        case 'bump-counter': {
          // Increment the counter resource and notify sessions subscribed to it
          counterValue++;
          const uri = 'test://dynamic/counter';
          await Promise.all(
            [...mcpServers.values()]
              .filter((s) => serverSubscriptions.get(s)?.has(uri))
              .map((s) => s.sendResourceUpdated({ uri }).catch(() => {}))
          );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ counter: counterValue }));
          return;
        }

        case 'notify-resource-updated': {
          // Fault injection: send notifications/resources/updated to ALL sessions,
          // regardless of server-side subscription state (exercises client filtering)
          const uri = url.searchParams.get('uri') || 'test://dynamic/counter';
          await Promise.all(
            [...mcpServers.values()].map((s) => s.sendResourceUpdated({ uri }).catch(() => {}))
          );
          res.writeHead(200);
          res.end(`Sent resources/updated for ${uri}`);
          return;
        }

        default:
          res.writeHead(404);
          res.end('Unknown control action');
          return;
      }
    }

    // OAuth client-credentials endpoints (opt-in via WITH_OAUTH). These must be
    // reachable without a Bearer token, so they precede the REQUIRE_AUTH check.
    if (WITH_OAUTH) {
      const handled = await handleOAuthEndpoints(req, res, url, {
        port: PORT,
        clientId: OAUTH_CLIENT_ID,
        clientSecret: OAUTH_CLIENT_SECRET,
        noMetadata: OAUTH_NO_METADATA,
      });
      if (handled) {
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
