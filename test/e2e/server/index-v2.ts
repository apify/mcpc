#!/usr/bin/env npx tsx
/**
 * Configurable MCP test server for E2E testing (MCP SDK v2, protocol
 * 2026-07-28 — the "modern" era column of the protocol-version test matrix;
 * see index.ts for the 2025-11-25 counterpart serving the same surface).
 *
 * Serves the same tools, resources, prompts, skills, and control endpoints as
 * index.ts (shared via fixtures.ts), over the stateless 2026-07-28 protocol:
 * no sessions, per-request identity `_meta`, and `subscriptions/listen`
 * streams instead of `resources/subscribe` + unsolicited notifications.
 *
 * Environment variables: same as index.ts, plus
 *   LEGACY_MODE - how 2025-era requests are answered (default: reject)
 *     reject    - v2-only strict mode: legacy requests get the
 *                 unsupported-protocol-version error, proving that clients
 *                 talk pure 2026-07-28 to this server
 *     stateless - serve 2025-era requests statelessly (no session IDs)
 *   NO_TASKS    - withhold the io.modelcontextprotocol/tasks extension, so
 *                 --task/--detach must refuse and slow-task runs synchronously
 *
 * Tasks: this server declares the 2026-07-28 tasks extension and answers a
 * `slow-task` call from a declaring client with a task handle
 * (`resultType: "task"`), then serves `tasks/get`, `tasks/cancel` and
 * `tasks/update` for it — the server-directed model of the extension, where
 * the client never asks for a task. The v2 SDK has no runtime for the
 * extension (its `Server` even refuses `tasks/get` as a 2025-only method), so
 * the tasks layer sits in front of the SDK handler, at the HTTP level.
 *
 * Control endpoints: same as index.ts where applicable, plus
 * `get-task-routing` (GET) — the `Mcp-Name` header the latest tasks/* requests
 * carried, so a suite can check the routing header the spec requires.
 * Session-oriented endpoints (get-active-sessions, get-deleted-sessions,
 * get-subscriptions, expire-session) respond with 501 — the 2026-07-28
 * protocol has no session state; suites that need them are legacy-era-specific.
 */

import {
  Server,
  createMcpHandler,
  ProtocolError,
  INVALID_PARAMS,
  CLIENT_CAPABILITIES_META_KEY,
  type ServerCapabilities,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import http from 'http';
import { randomUUID } from 'crypto';
import {
  TOOLS,
  RESOURCES,
  RESOURCE_TEMPLATES,
  PROMPTS,
  computeSkillsFixtures,
  passthroughSchema,
  paginate,
  callTestTool,
  readTestResource,
  getTestPrompt,
  handleOAuthEndpoints,
} from './fixtures.js';

// Configuration from environment (same variables as index.ts)
const PORT = parseInt(process.env.PORT || '13456', 10);
const PAGINATION_SIZE = parseInt(process.env.PAGINATION_SIZE || '0', 10);
const LATENCY_MS = parseInt(process.env.LATENCY_MS || '0', 10);
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true';
// With REQUIRE_AUTH, demand this exact bearer token rather than any well-formed one,
// so a test can prove a credential survived storage byte for byte.
const EXPECTED_BEARER_TOKEN = process.env.EXPECTED_BEARER_TOKEN || '';
const NO_TOOLS = process.env.NO_TOOLS === 'true';
const NO_RESOURCES = process.env.NO_RESOURCES === 'true';
const NO_PROMPTS = process.env.NO_PROMPTS === 'true';
// Withhold the tasks extension, so `--task`/`--detach` must refuse
const NO_TASKS = process.env.NO_TASKS === 'true';
const WITH_SKILLS = process.env.WITH_SKILLS === 'true';
const WITH_OTHER_EXTENSIONS = process.env.WITH_OTHER_EXTENSIONS === 'true';
const SKILLS_TAMPER = process.env.SKILLS_TAMPER;
const WITH_OAUTH = process.env.WITH_OAUTH === 'true';
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'test-client';
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || 's3cr3t';
const OAUTH_NO_METADATA = process.env.OAUTH_NO_METADATA === 'true';
const LEGACY_MODE = process.env.LEGACY_MODE === 'stateless' ? 'stateless' : 'reject';

// Control state (manipulated via /control/* endpoints). Module-level so it is
// shared across the per-request server instances the factory creates.
let failNextCount = 0;

// Client capabilities from the `_meta` envelope of the latest tools/call, so tests can
// check that mcpc declares its extensions on every request, not just server/discover
let lastClientCapabilities: unknown = null;

// Mutable counter resource state (bumped via /control/bump-counter)
let counterValue = 0;

// ---------------------------------------------------------------------------
// Tasks extension (io.modelcontextprotocol/tasks, MCP 2026-07-28)
// ---------------------------------------------------------------------------

const TASKS_EXTENSION_KEY = 'io.modelcontextprotocol/tasks';
const PROTOCOL_VERSION = '2026-07-28';
/** Polling cadence handed to clients — short, so suites finish fast. */
const TASK_POLL_INTERVAL_MS = 200;

type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

/** A task in the extension's flat shape, with the status-specific payload inlined. */
interface ExtensionTask {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs: number;
  result?: { content: Array<{ type: 'text'; text: string }> };
  error?: { code: number; message: string };
  inputRequests?: Record<string, unknown>;
}

interface TaskEntry {
  task: ExtensionTask;
  abort: AbortController;
  /** Resolves the wait of a task parked in input_required (tasks/update). */
  resumeInput?: () => void;
}

const taskStore = new Map<string, TaskEntry>();

// The Mcp-Name routing header of the latest tasks/* requests, newest last (the spec
// requires it to carry params.taskId), for the get-task-routing control endpoint
const taskRoutingLog: { method: string; taskId: string; mcpName: string | null }[] = [];
const TASK_ROUTING_LOG_SIZE = 20;

const isTerminal = (status: TaskStatus): boolean =>
  status === 'completed' || status === 'failed' || status === 'cancelled';

function touch(entry: TaskEntry, patch: Partial<ExtensionTask>): void {
  Object.assign(entry.task, patch, { lastUpdatedAt: new Date().toISOString() });
}

/**
 * Start `slow-task` as a task: `steps` progress steps spread over `ms`, then the same
 * result the synchronous tool returns. With `needsInput`, the task parks in
 * `input_required` after the first step, asking for a name, until `tasks/update` answers
 * or `tasks/cancel` ends it.
 */
function startSlowTask(args: Record<string, unknown>): ExtensionTask {
  const ms = Number(args.ms || 3000);
  const steps = Number(args.steps || 3);
  const needsInput = args.needsInput === true;
  const now = new Date().toISOString();
  const task: ExtensionTask = {
    taskId: randomUUID(),
    status: 'working',
    statusMessage: 'Starting...',
    createdAt: now,
    lastUpdatedAt: now,
    ttlMs: 300_000,
    pollIntervalMs: TASK_POLL_INTERVAL_MS,
  };
  const entry: TaskEntry = { task, abort: new AbortController() };
  taskStore.set(task.taskId, entry);

  void (async () => {
    const stepDuration = ms / steps;
    for (let i = 1; i <= steps; i++) {
      await new Promise((resolve) => setTimeout(resolve, stepDuration));
      if (entry.abort.signal.aborted) return;
      if (i === 1 && needsInput) {
        touch(entry, {
          status: 'input_required',
          statusMessage: 'Waiting for a name',
          inputRequests: {
            name: {
              method: 'elicitation/create',
              params: {
                mode: 'form',
                message: 'Please enter your name.',
                requestedSchema: {
                  type: 'object',
                  properties: { name: { type: 'string' } },
                  required: ['name'],
                },
              },
            },
          },
        });
        await new Promise<void>((resolve) => {
          entry.resumeInput = resolve;
        });
        if (entry.abort.signal.aborted) return;
        touch(entry, { status: 'working', statusMessage: 'Name received' });
        delete entry.task.inputRequests;
      }
      if (i < steps) {
        touch(entry, { statusMessage: `Processing step ${i}/${steps}` });
      } else {
        touch(entry, {
          status: 'completed',
          statusMessage: `Done (${steps} steps)`,
          result: { content: [{ type: 'text', text: `Completed ${steps} steps in ${ms}ms` }] },
        });
      }
    }
  })();

  return task;
}

/** A JSON-RPC result response the way the 2026-07-28 transport expects it. */
function jsonRpcResult(id: unknown, result: Record<string, unknown>): Response {
  return Response.json(
    { jsonrpc: '2.0', id, result },
    { headers: { 'mcp-protocol-version': PROTOCOL_VERSION } }
  );
}

/** A JSON-RPC error response (HTTP 200: the error is at the JSON-RPC layer). */
function jsonRpcError(id: unknown, code: number, message: string, data?: unknown): Response {
  return Response.json(
    { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } },
    { headers: { 'mcp-protocol-version': PROTOCOL_VERSION } }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Serve the tasks extension for one HTTP request, or return `undefined` to let the SDK
 * handler take it. Handles the task-creating `slow-task` call (for clients that declare
 * the extension — a server MUST NOT hand a task to any other) and the `tasks/*` methods.
 */
async function serveTasksExtension(request: Request): Promise<Response | undefined> {
  if (NO_TASKS || NO_TOOLS || request.method !== 'POST') return undefined;

  let message: unknown;
  try {
    message = await request.clone().json();
  } catch {
    return undefined;
  }
  if (!isRecord(message) || typeof message.method !== 'string') return undefined;
  const params = isRecord(message.params) ? message.params : {};
  const meta = isRecord(params._meta) ? params._meta : {};
  const clientCapabilities = meta[CLIENT_CAPABILITIES_META_KEY];
  const declared =
    isRecord(clientCapabilities) &&
    isRecord(clientCapabilities.extensions) &&
    clientCapabilities.extensions[TASKS_EXTENSION_KEY] !== undefined;

  if (message.method === 'tools/call' && params.name === 'slow-task') {
    // The server decides per call; here every slow-task call from a declaring client
    // becomes a task. A client that did not declare the extension gets the synchronous
    // tool from the SDK handler.
    if (!declared) return undefined;
    lastClientCapabilities = clientCapabilities;
    await maybeDelay();
    if (shouldFail()) return jsonRpcError(message.id, -32603, 'Simulated failure');
    const task = startSlowTask(isRecord(params.arguments) ? params.arguments : {});
    return jsonRpcResult(message.id, { resultType: 'task', ...task });
  }

  if (!['tasks/get', 'tasks/cancel', 'tasks/update'].includes(message.method)) return undefined;

  const taskId = typeof params.taskId === 'string' ? params.taskId : '';
  taskRoutingLog.push({ method: message.method, taskId, mcpName: request.headers.get('mcp-name') });
  if (taskRoutingLog.length > TASK_ROUTING_LOG_SIZE) taskRoutingLog.shift();

  if (!declared) {
    return jsonRpcError(message.id, -32021, 'Missing required client capability', {
      requiredCapabilities: { extensions: { [TASKS_EXTENSION_KEY]: {} } },
    });
  }
  const entry = taskStore.get(taskId);
  if (!entry) return jsonRpcError(message.id, INVALID_PARAMS, `Unknown task: ${taskId}`);

  switch (message.method) {
    case 'tasks/get':
      return jsonRpcResult(message.id, { resultType: 'complete', ...entry.task });

    case 'tasks/cancel':
      // Honored right away when the task is still running (cooperative in the spec, but
      // a test server has no reason to make clients wait for it)
      if (!isTerminal(entry.task.status)) {
        entry.abort.abort();
        entry.resumeInput?.();
        delete entry.task.inputRequests;
        touch(entry, { status: 'cancelled', statusMessage: 'Cancelled by request' });
      }
      return jsonRpcResult(message.id, { resultType: 'complete' });

    default: {
      // tasks/update: any answer to the outstanding request resumes the task
      if (entry.task.status === 'input_required' && isRecord(params.inputResponses)) {
        entry.resumeInput?.();
      }
      return jsonRpcResult(message.id, { resultType: 'complete' });
    }
  }
}

// Compute the effective skills resource list and content map at startup.
const {
  resources: SKILLS_RESOURCES,
  contents: SKILL_CONTENTS,
  skills: SKILLS,
  directories: SKILL_DIRECTORIES,
} = computeSkillsFixtures(WITH_SKILLS, SKILLS_TAMPER);

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

// Create a new MCP server instance. createMcpHandler calls this once per HTTP
// request (the stateless 2026-07-28 serving model), so it must be cheap and
// all mutable state must live at module level.
function createTestServer(): Server {
  // Build capabilities based on env config. No `tasks` capability: the
  // 2025-11-25 experimental tasks moved to the io.modelcontextprotocol/tasks
  // extension in 2026-07-28, which the v2 SDK does not implement yet.
  const capabilities: ServerCapabilities = {
    logging: {},
  };
  if (!NO_TOOLS) {
    capabilities.tools = { listChanged: true };
  }
  if (!NO_RESOURCES) {
    capabilities.resources = { subscribe: true, listChanged: true };
  }
  if (!NO_PROMPTS) {
    capabilities.prompts = { listChanged: true };
  }
  // Declare the skills extension, with directory reads, when skills are served.
  // Skills are modern-era only: the extension is specified against 2026-07-28 and
  // later, so index.ts (2025-11-25) serves none.
  if (WITH_SKILLS && !NO_RESOURCES) {
    capabilities.extensions = { 'io.modelcontextprotocol/skills': { directoryRead: true } };
  }

  // Declare the tasks extension (served by the HTTP-level tasks layer, see above) unless
  // a suite asked for a server without task support.
  if (!NO_TOOLS && !NO_TASKS) {
    capabilities.extensions = {
      ...((capabilities.extensions as Record<string, unknown>) || {}),
      [TASKS_EXTENSION_KEY]: {},
    };
  }

  // Extensions beyond the ones mcpc implements. A server declares what it serves on its
  // own terms, so the client has to name these without offering commands for them.
  if (WITH_OTHER_EXTENSIONS) {
    capabilities.extensions = {
      ...((capabilities.extensions as Record<string, unknown>) || {}),
      'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
      'com.example/widgets': {},
    };
  }

  const server = new Server(
    {
      name: 'e2e-test-server',
      version: '2.0.0',
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
    server.setRequestHandler('tools/list', async (request) => {
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      const { items, nextCursor } = paginate(TOOLS, request.params?.cursor, PAGINATION_SIZE);
      return { tools: items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
    });

    server.setRequestHandler('tools/call', async (request) => {
      lastClientCapabilities = server.getClientCapabilities() ?? null;
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      const { name, arguments: args } = request.params;
      return callTestTool(name, args);
    });
  }

  // Resources (only register handlers if capability is enabled)
  if (!NO_RESOURCES) {
    server.setRequestHandler('resources/list', async (request) => {
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      const all = [...RESOURCES, ...SKILLS_RESOURCES];
      const { items, nextCursor } = paginate(all, request.params?.cursor, PAGINATION_SIZE);
      return { resources: items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
    });

    server.setRequestHandler('resources/templates/list', async (request) => {
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      const { items, nextCursor } = paginate(
        RESOURCE_TEMPLATES,
        request.params?.cursor,
        PAGINATION_SIZE
      );
      return { resourceTemplates: items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
    });

    server.setRequestHandler('resources/read', async (request) => {
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

    // resources/subscribe and resources/unsubscribe exist only in the 2025-era
    // protocol (2026-07-28 uses subscriptions/listen streams, which
    // createMcpHandler serves itself). Registered for the legacy-stateless
    // serving mode; never reached in the default v2-only reject mode.
    server.setRequestHandler('resources/subscribe', async (request) => {
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      const { uri } = request.params;
      const known = [...RESOURCES, ...SKILLS_RESOURCES].some((r) => r.uri === uri);
      if (!known) {
        throw new Error(`Resource not found: ${uri}`);
      }
      return {};
    });

    server.setRequestHandler('resources/unsubscribe', async () => {
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      return {};
    });

    // Skills extension: skills/list, skills/get and the optional
    // resources/directory/read. Registered with explicit schemas because the SDK
    // carries no built-in vocabulary for extension methods.
    if (WITH_SKILLS) {
      server.setRequestHandler(
        'skills/list',
        { params: passthroughSchema<{ cursor?: string }>() },
        async (params) => {
          await maybeDelay();
          if (shouldFail()) {
            throw new Error('Simulated failure');
          }

          const { items, nextCursor } = paginate(SKILLS, params?.cursor, PAGINATION_SIZE);
          return {
            skills: items,
            ...(nextCursor !== undefined ? { nextCursor } : {}),
            ttlMs: 300000,
            cacheScope: 'public',
          };
        }
      );

      server.setRequestHandler(
        'skills/get',
        { params: passthroughSchema<{ uri: string }>() },
        async (params) => {
          await maybeDelay();
          if (shouldFail()) {
            throw new Error('Simulated failure');
          }

          const skill = SKILLS.find((entry) => entry.uri === params.uri);
          if (!skill) {
            throw new ProtocolError(INVALID_PARAMS, `No skill is served at ${params.uri}`);
          }
          return { skill, ttlMs: 300000, cacheScope: 'public' };
        }
      );

      server.setRequestHandler(
        'resources/directory/read',
        { params: passthroughSchema<{ uri: string; cursor?: string }>() },
        async (params) => {
          await maybeDelay();
          if (shouldFail()) {
            throw new Error('Simulated failure');
          }

          const children = SKILL_DIRECTORIES[params.uri];
          if (!children) {
            throw new ProtocolError(INVALID_PARAMS, `${params.uri} is not a directory resource`);
          }
          const { items, nextCursor } = paginate(children, params.cursor, PAGINATION_SIZE);
          return { resources: items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
        }
      );
    }
  }

  // Prompts (only register handlers if capability is enabled)
  if (!NO_PROMPTS) {
    server.setRequestHandler('prompts/list', async (request) => {
      await maybeDelay();
      if (shouldFail()) {
        throw new Error('Simulated failure');
      }

      const { items, nextCursor } = paginate(PROMPTS, request.params?.cursor, PAGINATION_SIZE);
      return { prompts: items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
    });

    server.setRequestHandler('prompts/get', async (request) => {
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
  }

  return server;
}

// Create HTTP server with the MCP handler and control endpoints
async function main() {
  const mcpHandler = createMcpHandler(() => createTestServer(), {
    legacy: LEGACY_MODE,
    onerror: (error) => {
      console.error('MCP handler error:', error.message);
    },
  });
  // The tasks layer answers what it knows and hands everything else to the SDK handler
  const nodeHandler = toNodeHandler({
    fetch: async (request, options) =>
      (await serveTasksExtension(request)) ?? mcpHandler.fetch(request, options),
  });

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

      // Session-oriented endpoints have no 2026-07-28 analogue (stateless
      // protocol, no session IDs) — answer 501 loudly so a suite that should
      // be marked legacy-era-specific fails visibly instead of silently.
      if (
        action === 'get-deleted-sessions' ||
        action === 'get-active-sessions' ||
        action === 'get-subscriptions' ||
        action === 'expire-session'
      ) {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: `${action} is not applicable to the 2026-07-28 test server` })
        );
        return;
      }

      if (action === 'get-client-capabilities' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ capabilities: lastClientCapabilities }));
        return;
      }

      if (action === 'get-task-routing' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ routing: taskRoutingLog }));
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end('Unknown control action');
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

        case 'reset':
          failNextCount = 0;
          counterValue = 0;
          lastClientCapabilities = null;
          taskRoutingLog.length = 0;
          res.writeHead(200);
          res.end('State reset');
          return;

        // Change notifications are published onto the handler's
        // subscriptions/listen bus: every open listen stream that opted in to
        // the notification type receives it (the 2026-07-28 delivery model).
        case 'notify-tools-changed':
          mcpHandler.notify.toolsChanged();
          res.writeHead(200);
          res.end('Sent tools/list_changed notification');
          return;

        case 'notify-prompts-changed':
          mcpHandler.notify.promptsChanged();
          res.writeHead(200);
          res.end('Sent prompts/list_changed notification');
          return;

        case 'notify-resources-changed':
          mcpHandler.notify.resourcesChanged();
          res.writeHead(200);
          res.end('Sent resources/list_changed notification');
          return;

        case 'bump-counter': {
          // Increment the counter resource and notify listen streams
          // subscribed to it
          counterValue++;
          mcpHandler.notify.resourceUpdated('test://dynamic/counter');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ counter: counterValue }));
          return;
        }

        case 'notify-resource-updated': {
          // Publish resources/updated for an arbitrary URI. Unlike the v1
          // server there is no "all sessions" fan-out to bypass: the bus
          // delivers only to listen streams whose honored filter includes the
          // URI (server-side filtering is inherent to the 2026-07-28 model).
          const uri = url.searchParams.get('uri') || 'test://dynamic/counter';
          mcpHandler.notify.resourceUpdated(uri);
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
      if (EXPECTED_BEARER_TOKEN && auth.slice('Bearer '.length) !== EXPECTED_BEARER_TOKEN) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: unexpected token' }));
        return;
      }
    }

    // MCP endpoint
    if (url.pathname === '/' || url.pathname === '/mcp') {
      await nodeHandler(req, res);
      return;
    }

    // 404 for unknown paths
    res.writeHead(404);
    res.end('Not found');
  });

  httpServer.listen(PORT, () => {
    console.log(`E2E test server (2026-07-28) running on http://localhost:${PORT}`);
    console.log(
      `  Pagination: ${PAGINATION_SIZE > 0 ? `${PAGINATION_SIZE} items/page` : 'disabled'}`
    );
    console.log(`  Latency: ${LATENCY_MS}ms`);
    console.log(`  Auth required: ${REQUIRE_AUTH}`);
    console.log(`  Legacy (2025-era) requests: ${LEGACY_MODE}`);
    if (NO_TOOLS) console.log(`  Tools: DISABLED`);
    if (NO_RESOURCES) console.log(`  Resources: DISABLED`);
    if (NO_PROMPTS) console.log(`  Prompts: DISABLED`);
    if (NO_TASKS) console.log(`  Tasks extension: DISABLED`);
    if (WITH_SKILLS) {
      console.log(`  Skills: ENABLED${SKILLS_TAMPER ? ` (tampered: ${SKILLS_TAMPER})` : ''}`);
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('Shutting down...');
    void mcpHandler.close().catch(() => {});
    httpServer.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
