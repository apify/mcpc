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

import type { Dispatcher } from 'undici';

let proxyAgent: Dispatcher | undefined;
let insecureRequested = false;

/**
 * Whether any proxy environment variable that EnvHttpProxyAgent acts on is set.
 * NO_PROXY alone does nothing without a proxy URL, so it is not checked.
 */
function proxyEnvConfigured(): boolean {
  return Boolean(
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy
  );
}

/**
 * Create the EnvHttpProxyAgent dispatcher, loading undici on demand.
 * undici costs ~100 ms to import, so it is only loaded when a proxy is
 * actually configured (or TLS verification is disabled) — with neither,
 * the native global fetch behaves identically without it.
 */
async function createProxyAgent(): Promise<Dispatcher> {
  const { EnvHttpProxyAgent } = await import('undici');
  return new EnvHttpProxyAgent(insecureRequested ? { connect: { rejectUnauthorized: false } } : {});
}

/**
 * Initialize HTTP proxy support from environment variables
 * (HTTPS_PROXY, HTTP_PROXY, NO_PROXY, and lowercase variants).
 *
 * Sets the global undici dispatcher AND initializes the proxy-aware fetch agent.
 * Must be called (and awaited) once at process startup, in the CLI and bridge
 * entry points. When no proxy is configured and TLS verification is not
 * disabled, this is a no-op and undici is never loaded.
 *
 * @param options.insecure - Disable TLS certificate verification (for self-signed certs)
 */
export async function initProxy(options?: { insecure?: boolean }): Promise<void> {
  insecureRequested = Boolean(options?.insecure);
  if (!insecureRequested && !proxyEnvConfigured()) {
    return;
  }
  const { setGlobalDispatcher } = await import('undici');
  proxyAgent = await createProxyAgent();
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
export async function proxyFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  if (!proxyAgent) {
    if (!insecureRequested && !proxyEnvConfigured()) {
      // No proxy configured — the native global fetch behaves identically,
      // and undici stays unloaded.
      return fetch(input, init);
    }
    proxyAgent = await createProxyAgent();
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
 * Call this on any path where the CLI process itself made HTTP requests (e.g. the
 * `login` token/OAuth calls) and is about to exit. Those requests leave idle
 * keep-alive sockets in undici's connection pool; closing them lets the event
 * loop empty so the process exits promptly on its own (set `process.exitCode`
 * and return — do NOT call `process.exit()`, which races libuv's handle teardown
 * on Windows and aborts with an async-handle assertion, `uv_async_send` on a
 * closing handle in `src\win\async.c`, corrupting `--json` error output).
 *
 * `destroy()` resolves near-instantly for idle keep-alive sockets, but it is
 * raced against a short timeout so a stuck connection can never stall the CLI's
 * exit. Best-effort throughout: teardown errors (including a late rejection that
 * lands after the timeout wins) are ignored.
 *
 * Some runtimes (e.g. Bun's undici shim) don't implement `destroy()` on the
 * dispatcher; this no-ops where it's unavailable (those runtimes drain promptly
 * on their own anyway).
 */
const CLOSE_TIMEOUT_MILLIS = 100;

export async function closeProxy(): Promise<void> {
  const agent = proxyAgent;
  proxyAgent = undefined;
  if (!agent || typeof agent.destroy !== 'function') {
    return;
  }
  // Swallow any (possibly late) teardown error so it can't surface as an
  // unhandled rejection when the timeout below wins the race.
  const destroyed = agent.destroy().catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CLOSE_TIMEOUT_MILLIS);
    timer.unref?.();
  });
  try {
    await Promise.race([destroyed, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
