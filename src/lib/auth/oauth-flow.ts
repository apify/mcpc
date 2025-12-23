/**
 * Interactive OAuth 2.1 flow with PKCE
 * Handles browser-based authorization with local callback server
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { Socket } from 'net';
import { URL } from 'url';
import { auth as sdkAuth } from '@modelcontextprotocol/sdk/client/auth.js';
import { McpcOAuthProvider } from './oauth-provider.js';
import { normalizeServerUrl } from '../utils.js';
import { ClientError } from '../errors.js';
import { createLogger } from '../logger.js';
import type { AuthProfile } from '../types.js';

const logger = createLogger('oauth-flow');

// Escape key code
const ESCAPE_KEY = '\x1b';

/**
 * Wait for user to press Escape key
 * Returns a promise that rejects when Escape is pressed
 */
function waitForEscapeKey(): { promise: Promise<never>; cleanup: () => void } {
  let cleanup = () => {};
  let cleaned = false;

  const promise = new Promise<never>((_resolve, reject) => {
    // Only set up key listener if stdin is a TTY
    if (!process.stdin.isTTY) {
      return; // Promise will never resolve/reject, which is fine
    }

    const onData = (key: Buffer) => {
      if (key.toString() === ESCAPE_KEY) {
        reject(new ClientError('Authentication cancelled by user'));
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
  logger.info(`Starting OAuth flow for ${serverUrl} (profile: ${profileName})`);

  // Normalize server URL
  const normalizedServerUrl = normalizeServerUrl(serverUrl);

  // Find available port for callback server
  const port = await findAvailablePort(8000);
  const redirectUrl = `http://localhost:${port}/callback`;

  logger.debug(`Using redirect URL: ${redirectUrl}`);

  // Create OAuth provider
  const provider = new McpcOAuthProvider(normalizedServerUrl, profileName, redirectUrl);

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

    // Override redirectToAuthorization to open browser
    provider.redirectToAuthorization = async (authorizationUrl: URL) => {
      logger.info('Opening browser for authorization...');
      console.log(`\nOpening browser to: ${authorizationUrl.toString()}`);
      console.log('If the browser does not open automatically, please visit the URL above.');
      console.log('Press Esc to cancel.\n');

      try {
        await openBrowser(authorizationUrl.toString());
      } catch (error) {
        console.error((error as Error).message);
      }
    };

    // Set up escape key handler
    const escapeHandler = waitForEscapeKey();

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
        const { code } = await Promise.race([
          codePromise,
          escapeHandler.promise,
        ]);

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
      escapeHandler.cleanup();
    }

    // Get the saved profile
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const profile = (provider as any)._authProfile as AuthProfile;
    if (!profile) {
      throw new ClientError('Failed to save authentication profile');
    }

    logger.info('OAuth flow completed successfully');
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
