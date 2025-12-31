/**
 * Interactive OAuth 2.1 flow with PKCE
 * Handles browser-based authorization with local callback server
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { Socket } from 'net';
import { URL } from 'url';
import { auth as sdkAuth } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthProvider } from './oauth-provider.js';
import { normalizeServerUrl } from '../utils.js';
import { ClientError } from '../errors.js';
import { createLogger } from '../logger.js';
import { removeKeychainOAuthClientInfo } from './keychain.js';
import type { AuthProfile } from '../types.js';

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
function setupKeyListener<T>(
  onKey: (char: string) => KeyHandlerResult<T>
): { promise: Promise<T>; cleanup: () => void } {
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

  process.stdout.write(prompt);

  const { promise } = setupKeyListener<boolean>((char) => {
    console.log(''); // Print newline after keypress
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
function startCallbackServer(port: number): {
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
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const errorDescription = url.searchParams.get('error_description');
      const state = url.searchParams.get('state') || undefined;

      if (error) {
        const message = errorDescription || error;
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <head><title>Authentication failed</title></head>
            <body>
              <h1>Authentication failed</h1>
              <p>Error: ${message}</p>
              <p>You can close this window.</p>
            </body>
          </html>
        `);
        rejectCode(new ClientError(`OAuth error: ${message}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <head><title>Authentication failed</title></head>
            <body>
              <h1>Authentication failed</h1>
              <p>No authorization code received</p>
              <p>You can close this window.</p>
            </body>
          </html>
        `);
        rejectCode(new ClientError('No authorization code in callback'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <head><title>Authentication successful</title></head>
          <body>
            <h1>Authentication successful!</h1>
            <p>You can close this window and return to the terminal.</p>
          </body>
        </html>
      `);
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
 * Find an available port for the callback server
 */
async function findAvailablePort(startPort: number = 8000): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
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
  throw new ClientError('Could not find available port for OAuth callback server');
}

/**
 * Open a URL in the default browser
 * Uses platform-specific commands
 */
async function openBrowser(url: string): Promise<void> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  const platform = process.platform;
  let command: string;

  if (platform === 'darwin') {
    command = `open "${url}"`;
  } else if (platform === 'win32') {
    command = `start "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  try {
    await execAsync(command);
    logger.debug('Browser opened successfully');
  } catch (error) {
    logger.warn(`Failed to open browser: ${(error as Error).message}`);
    throw new ClientError(`Failed to open browser. Please manually navigate to: ${url}`);
  }
}

/**
 * Perform interactive OAuth flow
 * Opens browser for user authentication and handles callback
 */
export async function performOAuthFlow(
  serverUrl: string,
  profileName: string,
  scope?: string
): Promise<OAuthFlowResult> {
  logger.debug(`Starting OAuth flow for ${serverUrl} (profile: ${profileName})`);

  // Normalize server URL
  const normalizedServerUrl = normalizeServerUrl(serverUrl);

  // Warn about OAuth over plain HTTP (except localhost)
  const parsedUrl = new URL(normalizedServerUrl);
  if (parsedUrl.protocol === 'http:' && parsedUrl.hostname !== 'localhost' && parsedUrl.hostname !== '127.0.0.1') {
    console.warn('\nWarning: OAuth over plain HTTP is insecure. Only use for local development.\n');
  }

  // Find available port for callback server
  const port = await findAvailablePort(8000);
  const redirectUrl = `http://localhost:${port}/callback`;

  logger.debug(`Using redirect URL: ${redirectUrl}`);

  // Delete existing OAuth client info from keychain before re-authenticating
  // This ensures we get a fresh client-id with the correct redirect URI
  // (old client-id might have been registered with different redirect URI)
  logger.debug(`Removing existing OAuth client info for ${profileName} @ ${normalizedServerUrl}`);
  await removeKeychainOAuthClientInfo(normalizedServerUrl, profileName);

  // Create OAuth provider in auth flow mode with forceReauth=true
  // This allows users to change scope or switch accounts
  // Old tokens are only overwritten after successful authentication
  const provider = new OAuthProvider({
    serverUrl: normalizedServerUrl,
    profileName,
    redirectUrl,
    forceReauth: true,
  });

  // Start callback server
  const { server, codePromise, destroyConnections } = startCallbackServer(port);

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
    const escapeHandlerRef: { current: ReturnType<typeof waitForEscapeKey> | null } = { current: null };

    // Override redirectToAuthorization to open browser
    provider.redirectToAuthorization = async (authorizationUrl: URL) => {
      logger.debug('Opening browser for authorization...');
      console.log(`\nAuthorization URL: ${authorizationUrl.toString()}`);

      // Ask for confirmation before opening browser
      const confirmed = await waitForEnterKey('Press Enter to open browser (any other key to cancel): ');
      if (!confirmed) {
        throw new ClientError('Authentication cancelled by user');
      }

      console.log('Opening browser...');
      console.log('If the browser does not open automatically, please visit the URL above.');
      console.log('Press Esc to cancel.\n');

      // Set up escape key handler AFTER Enter confirmation (to avoid raw mode conflicts)
      escapeHandlerRef.current = waitForEscapeKey();

      try {
        await openBrowser(authorizationUrl.toString());
      } catch (error) {
        console.error((error as Error).message);
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
        const racers: Promise<{ code: string }>[] = [codePromise];
        if (escapeHandlerRef.current) {
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
      // Clean up escape key handler
      escapeHandlerRef.current?.cleanup();
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
    logger.error(`OAuth flow failed: ${(error as Error).message}`);
    throw error;
  } finally {
    // Close callback server and destroy all connections
    destroyConnections();
    server.close();
  }
}
