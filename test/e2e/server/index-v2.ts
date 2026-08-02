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
 *
 * Control endpoints: same as index.ts where applicable. Session-oriented
 * endpoints (get-active-sessions, get-deleted-sessions, get-subscriptions,
 * expire-session) respond with 501 — the 2026-07-28 protocol has no session
 * state; suites that need them are legacy-era-specific.
 */

import { Server, createMcpHandler, type ServerCapabilities } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
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

// Configuration from environment (same variables as index.ts)
const PORT = parseInt(process.env.PORT || '13456', 10);
const PAGINATION_SIZE = parseInt(process.env.PAGINATION_SIZE || '0', 10);
const LATENCY_MS = parseInt(process.env.LATENCY_MS || '0', 10);
const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true';
const NO_TOOLS = process.env.NO_TOOLS === 'true';
const NO_RESOURCES = process.env.NO_RESOURCES === 'true';
const NO_PROMPTS = process.env.NO_PROMPTS === 'true';
const WITH_SKILLS = process.env.WITH_SKILLS === 'true';
const SKILLS_NO_INDEX = process.env.SKILLS_NO_INDEX === 'true';
const WITH_OAUTH = process.env.WITH_OAUTH === 'true';
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'test-client';
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || 's3cr3t';
const OAUTH_NO_METADATA = process.env.OAUTH_NO_METADATA === 'true';
const LEGACY_MODE = process.env.LEGACY_MODE === 'stateless' ? 'stateless' : 'reject';

// Control state (manipulated via /control/* endpoints). Module-level so it is
// shared across the per-request server instances the factory creates.
let failNextCount = 0;

// Mutable counter resource state (bumped via /control/bump-counter)
let counterValue = 0;

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
  // Advertise the experimental skills extension when skill resources are
  // exposed (SEP-2640), mirroring index.ts.
  if (WITH_SKILLS && !NO_RESOURCES) {
    const SKILLS_KEY = 'io.modelcontextprotocol/skills';
    capabilities.extensions = { [SKILLS_KEY]: {} };
    capabilities.experimental = { [SKILLS_KEY]: {} };
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
  const nodeHandler = toNodeHandler(mcpHandler);

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
    if (WITH_SKILLS) {
      console.log(`  Skills: ENABLED${SKILLS_NO_INDEX ? ' (index OFF, fallback only)' : ''}`);
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
