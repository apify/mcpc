/**
 * Proxy-aware fetch and global HTTP proxy setup
 *
 * Node.js native fetch (powered by undici) does not respect HTTP_PROXY/HTTPS_PROXY
 * environment variables, and undici's setGlobalDispatcher() is not honored by
 * libraries that manage their own HTTP connections (e.g., the MCP SDK's
 * StreamableHTTPClientTransport).
 *
 * This module provides:
 * 1. `initProxy()` — sets up the global undici dispatcher for proxy support
 *    and initializes the proxy-aware fetch. Must be called once at process startup.
 * 2. `proxyFetch()` — a fetch function that explicitly routes through the
 *    EnvHttpProxyAgent dispatcher, for use in code that bypasses the global dispatcher.
 */

import { EnvHttpProxyAgent, setGlobalDispatcher, type Dispatcher } from 'undici';

let proxyAgent: Dispatcher | undefined;

/**
 * Initialize HTTP proxy support from environment variables
 * (HTTPS_PROXY, HTTP_PROXY, NO_PROXY, and lowercase variants).
 *
 * Sets the global undici dispatcher AND initializes the proxy-aware fetch agent.
 * Must be called once at process startup (in CLI and bridge entry points).
 *
 * @param options.insecure - Disable TLS certificate verification (for self-signed certs)
 */
export function initProxy(options?: { insecure?: boolean }): void {
  proxyAgent = new EnvHttpProxyAgent(
    options?.insecure ? { connect: { rejectUnauthorized: false } } : {}
  );
  setGlobalDispatcher(proxyAgent);
}

/**
 * A fetch function that explicitly routes through the HTTP proxy configured via
 * environment variables. Use this where the global dispatcher is not respected
 * (e.g., MCP SDK transport, OAuth calls).
 *
 * Falls back to a default EnvHttpProxyAgent if initProxy() was not called.
 *
 * Note: this uses the *global* `fetch`, not undici's exported `fetch`, passing the
 * proxy dispatcher via the `dispatcher` init option (which the global fetch honors).
 * undici's exported fetch returns its own `Response` class, which is NOT an instance of
 * the global `Response`. Consumers that branch on `input instanceof Response` — notably
 * the MCP SDK's OAuth error parser — then mis-handle the result: they skip reading the
 * body, stringify the Response object to "[object Response]", and leave the undici body
 * stream unconsumed (which crashes the process on exit on Windows). Returning a global
 * `Response` keeps those checks working and the body properly drained.
 */
export function proxyFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (!proxyAgent) {
    proxyAgent = new EnvHttpProxyAgent();
  }
  // The cast bridges the type-only version skew between the runtime `undici` package's
  // Dispatcher and the `undici-types` Dispatcher baked into @types/node's global fetch;
  // EnvHttpProxyAgent is a valid dispatcher for the global fetch at runtime.
  return fetch(input, {
    ...init,
    dispatcher: proxyAgent as unknown as NonNullable<RequestInit['dispatcher']>,
  });
}

/**
 * Forcefully close the proxy dispatcher and all of its pooled connections.
 *
 * Call this right before a forced `process.exit()` on any path where the CLI
 * process itself made HTTP requests (e.g. the `login` token/OAuth calls). Those
 * requests leave idle keep-alive sockets in undici's connection pool; exiting
 * while they are still open races libuv's handle teardown on Windows and aborts
 * the process with an async-handle assertion (`uv_async_send` on a closing
 * handle, `src\win\async.c`). That stray native abort message lands on stderr
 * and corrupts otherwise-valid `--json` error output. Draining the pool first
 * makes the subsequent exit clean. Best-effort: teardown errors are ignored.
 */
export async function closeProxy(): Promise<void> {
  const agent = proxyAgent;
  proxyAgent = undefined;
  if (agent) {
    try {
      await agent.destroy();
    } catch {
      // Best-effort cleanup on the way out — nothing useful to do if it fails.
    }
  }
}
