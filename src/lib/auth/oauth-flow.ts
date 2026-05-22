/**
 * Interactive OAuth 2.1 flow with PKCE
 * Handles browser-based authorization with local callback server
 * Falls back to manual URL paste when browser is unavailable
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { Socket } from 'net';
import { URL } from 'url';
import { createInterface } from 'readline';
import { randomBytes } from 'crypto';
import { auth as sdkAuth } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthProvider, type OAuthProviderOptions } from './oauth-provider.js';
import { getServerHost, normalizeServerUrl } from '../utils.js';
import { ClientError } from '../errors.js';
import { createLogger } from '../logger.js';
import { removeKeychainOAuthClientInfo, storeKeychainOAuthClientInfo } from './keychain.js';
import type { AuthProfile } from '../types.js';
import { MCPC_OAUTH_CALLBACK_PORTS, validateClientMetadataUrl } from './oauth-utils.js';
import { renderAuthPage } from './auth-page.js';

const logger = createLogger('oauth-flow');

// Special key codes
const ESCAPE_KEY = '\x1b';
const CTRL_C = '\x03';
const ENTER_CR = '\r';
const ENTER_LF = '\n';

/**
 * Result from key handler callback
 */
type KeyHandlerResult<T> =
  | { done: true; value: T }
  | { done: true; error: Error }
  | { done: false };

/**
 * Set up raw mode keypress listener
 * Returns cleanup function and allows custom key handling via callback
 */
function setupKeyListener<T>(onKey: (char: string) => KeyHandlerResult<T>): {
  promise: Promise<T>;
  cleanup: () => void;
} {
  let cleanup = () => {};
  let cleaned = false;

  const promise = new Promise<T>((resolve, reject) => {
    // Only set up key listener if stdin is a TTY
    if (!process.stdin.isTTY) {
      return; // Promise will never resolve, which is fine for non-TTY
    }

    const onData = (key: Buffer) => {
      const result = onKey(key.toString());
      if (result.done) {
        cleanup();
        if ('error' in result) {
          reject(result.error);
        } else {
          resolve(result.value);
        }
      }
    };

    // Enable raw mode to capture individual keypresses
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);

    cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
  });

  return { promise, cleanup };
}

/**
 * Wait for user to press Escape key
 * Returns a promise that rejects when Escape is pressed
 */
function waitForEscapeKey(): { promise: Promise<never>; cleanup: () => void } {
  const { promise, cleanup } = setupKeyListener<never>((char) => {
    if (char === ESCAPE_KEY || char === CTRL_C) {
      return { done: true, error: new ClientError('Authentication cancelled by user') };
    }
    return { done: false };
  });
  return { promise, cleanup };
}

/**
 * Prompt user to press Enter to continue
 * Returns true if Enter was pressed, false otherwise
 */
async function waitForEnterKey(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return true;
  }

  process.stderr.write(prompt);

  const { promise } = setupKeyListener<boolean>((char) => {
    console.error(''); // Print newline after keypress
    if (char === ENTER_CR || char === ENTER_LF) {
      return { done: true, value: true };
    }
    // Any other key cancels
    return { done: true, value: false };
  });

  return promise;
}

/**
 * Result of OAuth flow
 */
export interface OAuthFlowResult {
  profile: AuthProfile;
  success: boolean;
}

/**
 * Start a local HTTP server for OAuth callback
 * Returns the server, a promise that resolves with the authorization code, and a destroy function
 */
function startCallbackServer(
  port: number,
  context: { serverUrl: string; profileName: string; scope?: string }
): {
  server: Server;
  codePromise: Promise<{ code: string; state?: string }>;
  destroyConnections: () => void;
} {
  let resolveCode: (value: { code: string; state?: string }) => void;
  let rejectCode: (error: Error) => void;

  const codePromise = new Promise<{ code: string; state?: string }>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  // Track active connections so we can forcibly close them
  const sockets = new Set<Socket>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Validate Host header to prevent DNS rebinding attacks.
    // Only allow requests explicitly targeting localhost or 127.0.0.1.
    const host = req.headers.host || '';
    const hostWithoutPort = host.split(':')[0] || '';
    if (hostWithoutPort !== 'localhost' && hostWithoutPort !== '127.0.0.1') {
      logger.warn(`Rejected OAuth callback request with unexpected Host header: ${host}`);
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${port}`);

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const errorDescription = url.searchParams.get('error_description');
      const state = url.searchParams.get('state') || undefined;

      const info = [
        { label: 'Server', value: getServerHost(context.serverUrl) },
        { label: 'Profile', value: context.profileName },
        { label: 'Scopes', value: context.scope },
      ];

      if (error) {
        const message = errorDescription || error;
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          renderAuthPage({
            success: false,
            title: 'mcpc login failed',
            message: 'The authorization server returned an error.',
            detail: message,
            info,
          })
        );
        rejectCode(new ClientError(`OAuth error: ${message}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          renderAuthPage({
            success: false,
            title: 'mcpc login failed',
            message: 'No authorization code was received from the server.',
            info,
          })
        );
        rejectCode(new ClientError('No authorization code in callback'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        renderAuthPage({
          success: true,
          title: 'mcpc login succeeded',
          message:
            'Your authentication profile has been securely saved. You can now use it in your mcpc sessions.',
          info,
        })
      );
      const result: { code: string; state?: string } = { code };
      if (state !== undefined) {
        result.state = state;
      }
      resolveCode(result);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  // Track connections for cleanup
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  // Function to forcibly close all connections
  const destroyConnections = () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
  };

  return { server, codePromise, destroyConnections };
}

/**
 * Find an available port for the OAuth callback server.
 * Tries each port in `ports` in order and returns the first free one.
 * Throws if all ports are occupied.
 */
async function findAvailablePort(ports: readonly number[]): Promise<number> {
  for (const port of ports) {
    try {
      await new Promise<void>((resolve, reject) => {
        const testServer = createServer();
        testServer.once('error', reject);
        testServer.once('listening', () => {
          testServer.close(() => resolve());
        });
        testServer.listen(port, '127.0.0.1');
      });
      return port;
    } catch {
      // Port is in use, try next one
    }
  }
  throw new ClientError(
    `Could not find available port for OAuth callback server (tried ports ${ports.join(', ')}). ` +
      'Another mcpc login may be in progress — wait for it to finish and try again.'
  );
}

/**
 * Open a URL in the default browser
 * Uses platform-specific commands
 * Returns true if the browser was opened successfully, false otherwise
 */
async function tryOpenBrowser(url: string): Promise<boolean> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  const platform = process.platform;
  let command: string;
  let args: string[];

  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    // On Windows, use cmd.exe /c start to open URLs.
    // The empty "" is the window title argument required by 'start' when the target contains special characters.
    command = 'cmd.exe';
    args = ['/c', 'start', '""', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    await execFileAsync(command, args);
    logger.debug('Browser opened successfully');
    return true;
  } catch (error) {
    logger.warn(`Failed to open browser: ${(error as Error).message}`);
    return false;
  }
}

/**
 * Extract authorization code and state from a callback URL
 * Parses URLs like: http://localhost:8000/callback?code=abc123&state=xyz
 */
function extractCodeFromUrl(callbackUrl: string): { code: string; state?: string } {
  try {
    // Handle both full URLs and just query strings
    const url = callbackUrl.startsWith('http')
      ? new URL(callbackUrl)
      : new URL(callbackUrl, 'http://localhost');

    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');
    const state = url.searchParams.get('state') || undefined;

    if (error) {
      const message = errorDescription || error;
      throw new ClientError(`OAuth error: ${message}`);
    }

    if (!code) {
      throw new ClientError(
        'No authorization code found in the URL. Make sure you copied the full URL from the browser address bar after authorizing.'
      );
    }

    const result: { code: string; state?: string } = { code };
    if (state !== undefined) {
      result.state = state;
    }
    return result;
  } catch (e) {
    if (e instanceof ClientError) throw e;
    throw new ClientError(
      'Invalid URL. Please paste the full URL from the browser address bar after authorizing.'
    );
  }
}

/**
 * Prompt user to paste the callback URL from their browser
 * Uses readline (not raw mode) so it works in all terminal environments
 */
function promptForCallbackUrl(): {
  promise: Promise<{ code: string; state?: string }>;
  cleanup: () => void;
} {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    rl.close();
  };

  const promise = new Promise<{ code: string; state?: string }>((resolve, reject) => {
    rl.question('\nPaste the callback URL from your browser here:\n> ', (answer: string) => {
      cleanup();
      const trimmed = answer.trim();
      if (!trimmed) {
        reject(new ClientError('Authentication cancelled by user'));
        return;
      }
      try {
        resolve(extractCodeFromUrl(trimmed));
      } catch (e) {
        reject(e);
      }
    });

    rl.on('close', () => {
      // Handle Ctrl+C / Ctrl+D
      if (!cleaned) {
        cleaned = true;
        reject(new ClientError('Authentication cancelled by user'));
      }
    });
  });

  return { promise, cleanup };
}

/**
 * Perform interactive OAuth flow
 * Opens browser for user authentication and handles callback
 * Falls back to manual URL paste when browser cannot be opened
 */
export async function performOAuthFlow(
  serverUrl: string,
  profileName: string,
  scope?: string,
  clientCredentials?: { clientId?: string; clientSecret?: string; clientMetadataUrl?: string },
  callbackPort?: number
): Promise<OAuthFlowResult> {
  logger.debug(`Starting OAuth flow for ${serverUrl} (profile: ${profileName})`);

  // Normalize server URL
  const normalizedServerUrl = normalizeServerUrl(serverUrl);

  // Warn about OAuth over plain HTTP (except localhost)
  const parsedUrl = new URL(normalizedServerUrl);
  if (
    parsedUrl.protocol === 'http:' &&
    parsedUrl.hostname !== 'localhost' &&
    parsedUrl.hostname !== '127.0.0.1'
  ) {
    console.warn('\nWarning: OAuth over plain HTTP is insecure. Only use for local development.\n');
  }

  // When --callback-port is set, use that exact port. Otherwise try the
  // fixed mcpc port list that matches the hosted CIMD's redirect_uris.
  const port = await findAvailablePort(callbackPort ? [callbackPort] : MCPC_OAUTH_CALLBACK_PORTS);
  const redirectUrl = `http://127.0.0.1:${port}/callback`;

  logger.debug(`Using redirect URL: ${redirectUrl}`);

  // Validate --client-metadata-url (CIMD) early so users get a clear error
  if (clientCredentials?.clientMetadataUrl) {
    validateClientMetadataUrl(clientCredentials.clientMetadataUrl);
  }

  // When client credentials are provided, skip deleting existing client info
  // and pre-store the credentials so the provider uses them instead of dynamic registration
  let resolvedClientCredentials: { clientId: string; clientSecret?: string } | undefined;
  if (clientCredentials?.clientId) {
    logger.debug(`Using provided client credentials for ${profileName} @ ${normalizedServerUrl}`);
    resolvedClientCredentials = { clientId: clientCredentials.clientId };
    if (clientCredentials.clientSecret) {
      resolvedClientCredentials.clientSecret = clientCredentials.clientSecret;
    }
    await storeKeychainOAuthClientInfo(normalizedServerUrl, profileName, resolvedClientCredentials);
  } else {
    // Delete existing OAuth client info from keychain before re-authenticating.
    // This ensures we get a fresh client-id with the correct redirect URI
    // (an old client-id may have been registered with a different redirect URI,
    // or the authorization server may now advertise CIMD support, etc).
    logger.debug(`Removing existing OAuth client info for ${profileName} @ ${normalizedServerUrl}`);
    await removeKeychainOAuthClientInfo(normalizedServerUrl, profileName);
  }

  // Create OAuth provider in auth flow mode with forceReauth=true
  // This allows users to change scope or switch accounts
  // Old tokens are only overwritten after successful authentication
  const providerOptions: OAuthProviderOptions = {
    serverUrl: normalizedServerUrl,
    profileName,
    redirectUrl,
    forceReauth: true,
  };
  if (resolvedClientCredentials) {
    providerOptions.clientCredentials = resolvedClientCredentials;
  }
  if (clientCredentials?.clientMetadataUrl) {
    providerOptions.clientMetadataUrl = clientCredentials.clientMetadataUrl;
  }
  const provider = new OAuthProvider(providerOptions);

  // Start callback server
  const callbackContext: { serverUrl: string; profileName: string; scope?: string } = {
    serverUrl: normalizedServerUrl,
    profileName,
  };
  if (scope !== undefined) {
    callbackContext.scope = scope;
  }
  const { server, codePromise, destroyConnections } = startCallbackServer(port, callbackContext);

  // Track whether browser failed so we can fall back to URL paste
  let browserFailed = false;

  // Handler refs for cleanup
  const pasteHandlerRef: { current: { cleanup: () => void } | null } = { current: null };

  try {
    // Start server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        logger.debug(`Callback server listening on port ${port}`);
        resolve();
      });
    });

    // Escape handler - set up after browser opens (use object wrapper to avoid TypeScript closure narrowing)
    const escapeHandlerRef: { current: ReturnType<typeof waitForEscapeKey> | null } = {
      current: null,
    };

    // Override redirectToAuthorization to open browser
    provider.redirectToAuthorization = async (authorizationUrl: URL) => {
      // Inject a random `state` parameter if the SDK didn't add one. OAuth 2.1 treats
      // `state` as RECOMMENDED rather than REQUIRED, but RFC 6749 §4.1.1 allows servers
      // to require it, and some production MCP servers do (e.g. Ubersuggest). PKCE
      // already provides CSRF protection on this flow, so the value need not be verified.
      if (!authorizationUrl.searchParams.has('state')) {
        authorizationUrl.searchParams.set('state', randomBytes(16).toString('hex'));
      }

      logger.debug('Opening browser for authorization...');
      // Interactive chatter goes to stderr so stdout stays clean for --json output.
      console.error(`\nAuthorization URL: ${authorizationUrl.toString()}`);

      // Ask for confirmation before opening browser
      const confirmed = await waitForEnterKey(
        'Press Enter to open browser (any other key to cancel): '
      );
      if (!confirmed) {
        throw new ClientError('Authentication cancelled by user');
      }

      console.error('Opening browser...');
      const opened = await tryOpenBrowser(authorizationUrl.toString());

      if (opened) {
        console.error('If the browser does not open automatically, please visit the URL above.');
        console.error('Press Esc to cancel.\n');
        // Set up escape key handler AFTER Enter confirmation (to avoid raw mode conflicts)
        escapeHandlerRef.current = waitForEscapeKey();
      } else {
        browserFailed = true;
        console.error(
          '\nCould not open browser. Please open the authorization URL above in your browser.'
        );
        console.error(
          'After authorizing, copy the full callback URL from the browser address bar and paste it here.'
        );
      }
    };

    try {
      // Start OAuth flow
      logger.debug('Calling SDK auth()...');
      const authOptions: { serverUrl: string; scope?: string } = {
        serverUrl: normalizedServerUrl,
      };
      if (scope !== undefined) {
        authOptions.scope = scope;
      }
      const result = await sdkAuth(provider, authOptions);

      if (result === 'REDIRECT') {
        // Wait for callback with authorization code, or user pressing Escape
        logger.debug('Waiting for authorization code...');
        const racers: Promise<{ code: string; state?: string }>[] = [codePromise];

        if (browserFailed) {
          // Browser didn't open - also accept pasted callback URL
          const urlHandler = promptForCallbackUrl();
          pasteHandlerRef.current = urlHandler;
          racers.push(urlHandler.promise);
        } else if (escapeHandlerRef.current) {
          racers.push(escapeHandlerRef.current.promise as Promise<{ code: string }>);
        }

        const { code } = await Promise.race(racers);

        // Exchange code for tokens
        logger.debug('Exchanging authorization code for tokens...');
        const tokenOptions: { serverUrl: string; authorizationCode: string; scope?: string } = {
          serverUrl: normalizedServerUrl,
          authorizationCode: code,
        };
        if (scope !== undefined) {
          tokenOptions.scope = scope;
        }
        await sdkAuth(provider, tokenOptions);
      }
    } finally {
      // Clean up escape key handler and paste handler
      escapeHandlerRef.current?.cleanup();
      pasteHandlerRef.current?.cleanup();
    }

    // Get the saved profile
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const profile = (provider as any)._authProfile as AuthProfile;
    if (!profile) {
      throw new ClientError('Failed to save authentication profile');
    }

    logger.debug('OAuth flow completed successfully');
    return {
      profile,
      success: true,
    };
  } catch (error) {
    logger.debug(`OAuth flow failed: ${(error as Error).message}`);
    throw error;
  } finally {
    // Clean up paste handler in case of error
    pasteHandlerRef.current?.cleanup();
    // Close callback server and destroy all connections
    destroyConnections();
    server.close();
  }
}
