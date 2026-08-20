#!/usr/bin/env node
/**
 * Bridge process for maintaining persistent MCP connections
 * This executable is spawned by the CLI and maintains a long-running connection to an MCP server
 * It communicates with the CLI via Unix domain sockets
 */

import { initProxy, proxyFetch } from '../lib/proxy.js';
import { createServer, type Server as NetServer, type Socket } from 'net';
import { unlink } from 'fs/promises';
import { dirname } from 'path';
import {
  createMcpClient,
  CreateMcpClientOptions,
  buildClientCapabilities,
  tasksUnsupportedByServerMessage,
} from '../core/index.js';
import type { McpClient } from '../core/index.js';
import type {
  ServerConfig,
  IpcMessage,
  LoggingLevel,
  X402SchemePreference,
  ServerDetails,
} from '../lib/index.js';
import {
  KEEPALIVE_INTERVAL_MILLIS,
  MAX_PERSISTED_INSTRUCTIONS_CHARS,
  TRIMMED_INSTRUCTIONS_NOTICE,
  X402_SCHEME_PREFERENCES,
} from '../lib/types.js';
import { createLogger, setVerbose, initFileLogger, closeFileLogger } from '../lib/index.js';
import {
  fileExists,
  getSocketPath,
  getShortSocketDir,
  ensureDir,
  ensureSecureTempDir,
  cleanupOrphanedLogFiles,
  isProtocolMismatchError,
  isSessionExpiredError,
  truncate,
  StderrTail,
} from '../lib/index.js';
import {
  ClientError,
  ServerError,
  NetworkError,
  AuthError,
  isAuthenticationError,
} from '../lib/index.js';
import { getSession, loadSessions, updateSession } from '../lib/sessions.js';
import type { AuthCredentials, X402WalletCredentials } from '../lib/types.js';
import { OAuthTokenManager } from '../lib/auth/oauth-token-manager.js';
import { OAuthProvider } from '../lib/auth/oauth-provider.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/client';
import {
  storeKeychainOAuthTokenInfo,
  readKeychainOAuthTokenInfo,
  storeKeychainIdJagCredentials,
  readKeychainIdJagCredentials,
} from '../lib/auth/keychain.js';
import { updateAuthProfileRefreshedAt } from '../lib/auth/profiles.js';
import { createClientCredentialsProvider } from '../lib/auth/client-credentials.js';
import { createIdJagProvider } from '../lib/auth/id-jag.js';
import type { Tool, Resource, Prompt, Task } from '@modelcontextprotocol/client';
import { ResourceSyncManager } from './resource-sync.js';
import { isModernProtocolVersion } from '../core/protocol.js';
import type { TaskUpdate } from '../lib/types.js';
import { createRequire } from 'module';
const { version: mcpcVersion } = createRequire(import.meta.url)('../../package.json') as {
  version: string;
};
import { ProxyServer } from './proxy-server.js';
import type { ProxyConfig } from '../lib/types.js';
// x402 modules pull in the bundled viem (~1 MB of crypto code) — import types
// only here and load the implementations lazily at the x402-gated call sites.
import type { X402PaymentCache } from '../lib/x402/fetch-middleware.js';
import type { SignerWallet } from '../lib/x402/signer.js';
import type { FetchLike } from '@modelcontextprotocol/client';

// HTTP proxy and TLS settings are configured in main() after parsing --insecure flag

// KEEPALIVE_INTERVAL_MILLIS imported from ../lib/types.js

// Maximum IPC buffer size (10 MB) — destroy socket if exceeded
const MAX_BUFFER_SIZE = 10 * 1024 * 1024;

const logger = createLogger('bridge');

interface BridgeOptions {
  sessionName: string;
  serverConfig: ServerConfig;
  verbose?: boolean;
  profileName?: string; // Auth profile name for token refresh
  proxyConfig?: ProxyConfig; // Proxy server configuration
  mcpSessionId?: string; // MCP session ID for resumption (Streamable HTTP only)
  protocolVersion?: string; // Protocol version negotiated by the resumed session (only set with mcpSessionId)
  /** x402 scheme preference; presence enables x402 auto-payment, absence disables. */
  x402?: X402SchemePreference;
  insecure?: boolean; // Skip TLS certificate verification
}

/**
 * Bridge process class
 * Manages MCP connection and Unix socket server for a single session
 */
class BridgeProcess {
  private client: McpClient | null = null;
  private server: NetServer | null = null;
  private proxyServer: ProxyServer | null = null;
  private connections: Set<Socket> = new Set();
  private options: BridgeOptions;
  private socketPath: string;
  private isShuttingDown = false;
  private keepaliveInterval: NodeJS.Timeout | null = null;

  // OAuth token manager (created when CLI sends auth credentials via IPC)
  private tokenManager: OAuthTokenManager | null = null;

  // OAuth provider for SDK transport. Either mcpc's OAuthProvider (authorization-code
  // runtime mode, wraps tokenManager) or an SDK client-credentials provider.
  private authProvider: OAuthClientProvider | null = null;

  // True when authProvider is a client-credentials provider — drives the
  // `oauth-client-credentials` extension capability declaration on initialize.
  private usesClientCredentials = false;

  // True when authProvider is an enterprise-managed-authorization (id_jag) provider —
  // drives the `enterprise-managed-authorization` extension capability declaration.
  private usesIdJag = false;

  // HTTP headers (received via IPC, stored in memory only)
  private headers: Record<string, string> | null = null;

  // Bearer token the proxy server requires (received via IPC, stored in memory only).
  // Read by the CLI before spawn and sent over IPC — never read from the keychain here,
  // keeping the bridge's only keychain access on the OAuth-refresh path (see #55).
  private proxyBearerToken: string | null = null;

  // x402 wallet for automatic payment signing (received via IPC, stored in memory only)
  private x402Wallet: SignerWallet | null = null;

  // Shared payment signature cache — middleware reads/writes, bridge invalidates on payment-required results
  private x402PaymentCache: X402PaymentCache = { signature: null };

  // Active async tasks (in-memory, also persisted to disk for crash recovery)
  private activeTasks: Map<string, Task> = new Map();

  // Resource→file sync for resources-subscribe (created once the MCP client connects)
  private resourceSync: ResourceSyncManager | null = null;

  // Handshake results persisted at the original connect, used only when this bridge
  // resumed a server-side session: resumption skips `initialize`, so the SDK client
  // reports no serverInfo/capabilities/instructions of its own (see #325).
  private resumedHandshakeDetails: Pick<
    ServerDetails,
    'serverInfo' | 'capabilities' | 'instructions' | 'supportedVersions' | '_meta'
  > | null = null;

  // Promise to track when auth credentials are received (for startup sequencing)
  private authCredentialsReceived: Promise<void> | null = null;
  private authCredentialsResolver: (() => void) | null = null;

  // Promise to track when x402 wallet is received (for startup sequencing)
  private x402WalletReceived: Promise<void> | null = null;
  private x402WalletResolver: (() => void) | null = null;

  // Promise to track when MCP client is connected (for blocking requests until ready)
  private mcpClientReady: Promise<void>;
  private mcpClientReadyResolver!: () => void;
  private mcpClientReadyRejecter!: (error: Error) => void;

  // Bounded tail of stderr lines emitted by a stdio server, surfaced in the
  // connect-failure error so the CLI can show users why startup failed
  // (e.g. TLS errors when NODE_EXTRA_CA_CERTS is not forwarded — see #195).
  private readonly stderrTail = new StderrTail();

  constructor(options: BridgeOptions) {
    this.options = options;
    // Each bridge instance gets a unique socket path based on its PID, so that
    // overlapping bridges (e.g. background reconnect racing with explicit restart)
    // never delete each other's sockets during cleanup.
    this.socketPath = getSocketPath(options.sessionName, process.pid);

    // Create promise that resolves when MCP client connects
    this.mcpClientReady = new Promise<void>((resolve, reject) => {
      this.mcpClientReadyResolver = resolve;
      this.mcpClientReadyRejecter = reject;
    });
    // Mark the promise as handled so a rejection without a current awaiter
    // (e.g. auto-restart bridge with no connected IPC client) doesn't crash
    // the bridge before it can persist the failure status to sessions.json.
    // Subsequent `await this.mcpClientReady` calls still see the rejection.
    this.mcpClientReady.catch(() => {});

    if (options.verbose) {
      setVerbose(true);
    }
  }

  /**
   * Set auth credentials received from CLI via IPC
   * Handles both OAuth (with refresh token) and HTTP headers
   */
  setAuthCredentials(credentials: AuthCredentials): void {
    logger.info(`Received auth credentials for profile: ${credentials.profileName}`);
    logger.debug(`  serverUrl: ${credentials.serverUrl}`);
    logger.debug(`  refreshToken: ${credentials.refreshToken ? 'present' : 'MISSING'}`);
    logger.debug(`  accessToken: ${credentials.accessToken ? 'present' : 'MISSING'}`);
    logger.debug(`  clientId: ${credentials.clientId ? 'present' : 'MISSING'}`);
    logger.debug(`  oauthGrant: ${credentials.oauthGrant ?? 'authorization_code'}`);
    logger.debug(`  clientSecret: ${credentials.clientSecret ? 'present' : 'absent'}`);
    logger.debug(`  privateKey: ${credentials.privateKeyPem ? 'present' : 'absent'}`);
    logger.debug(`  headers: ${credentials.headers ? Object.keys(credentials.headers).length : 0}`);
    logger.debug(`  proxyBearerToken: ${credentials.proxyBearerToken ? 'present' : 'absent'}`);
    logger.debug(`  idJag: ${credentials.idJag ? 'present' : 'absent'}`);

    // Enterprise-managed authorization (id_jag): build the SDK cross-app-access
    // provider. It exchanges the stored IdP ID token for an ID-JAG and the ID-JAG
    // for an MCP access token — the SDK transport drives it, like client-credentials.
    if (credentials.oauthGrant === 'id_jag' && credentials.idJag) {
      const idJag = credentials.idJag;
      logger.debug(`  idToken: ${idJag.idToken ? 'present' : 'MISSING'}`);
      logger.debug(`  idpRefreshToken: ${idJag.idpRefreshToken ? 'present' : 'absent'}`);
      this.authProvider = createIdJagProvider(idJag, {
        serverUrl: credentials.serverUrl,
        profileName: credentials.profileName,
        callbacks: {
          // Reload the material before each exchange (another process may have
          // rotated the IdP refresh token). Keychain reads/writes here are the
          // sanctioned OAuth token refresh path (see #55) — the initial material
          // was still loaded CLI-side pre-spawn and delivered via IPC.
          reloadCredentials: async () => {
            logger.debug('Reloading id-jag material from keychain before exchange...');
            return readKeychainIdJagCredentials(credentials.serverUrl, credentials.profileName);
          },
          // Persist rotated IdP tokens after an ID token refresh.
          onIdTokenRefresh: async (updated) => {
            logger.debug('IdP ID token refreshed, persisting to keychain');
            await storeKeychainIdJagCredentials(
              credentials.serverUrl,
              credentials.profileName,
              updated
            );
            await updateAuthProfileRefreshedAt(credentials.serverUrl, credentials.profileName);
            logger.debug('Profile refreshedAt timestamp updated');
          },
        },
      });
      this.usesIdJag = true;
      logger.debug('Enterprise-managed authorization (id-jag) provider created for SDK transport');
    } else if (credentials.oauthGrant === 'client_credentials' && credentials.clientId) {
      // Client-credentials grant: build the SDK provider that fetches + refreshes
      // tokens itself. No token manager / no static header — the SDK transport drives it.
      this.authProvider = createClientCredentialsProvider({
        clientId: credentials.clientId,
        ...(credentials.clientSecret ? { clientSecret: credentials.clientSecret } : {}),
        ...(credentials.privateKeyPem ? { privateKeyPem: credentials.privateKeyPem } : {}),
        ...(credentials.keyAlg ? { keyAlg: credentials.keyAlg } : {}),
        ...(credentials.scope ? { scope: credentials.scope } : {}),
        ...(credentials.tokenEndpoint ? { tokenEndpoint: credentials.tokenEndpoint } : {}),
      });
      this.usesClientCredentials = true;
      logger.debug('Client-credentials provider created for SDK transport');
      // Set up OAuth token manager if refresh token and client ID are provided
    } else if (credentials.refreshToken && credentials.clientId) {
      this.tokenManager = new OAuthTokenManager({
        serverUrl: credentials.serverUrl,
        profileName: credentials.profileName,
        clientId: credentials.clientId,
        refreshToken: credentials.refreshToken,
        // Reload tokens from keychain before refresh (handles token rotation by other processes)
        onBeforeRefresh: async () => {
          logger.debug('Reloading tokens from keychain before refresh...');
          const tokenInfo = await readKeychainOAuthTokenInfo(
            credentials.serverUrl,
            credentials.profileName
          );
          if (!tokenInfo) {
            logger.debug('No tokens found in keychain');
            return undefined;
          }
          logger.debug('Loaded tokens from keychain');
          // Build result object with only defined properties (for exactOptionalPropertyTypes)
          const result: {
            refreshToken?: string;
            accessToken?: string;
            accessTokenExpiresAt?: number;
          } = {
            accessToken: tokenInfo.accessToken,
          };
          if (tokenInfo.refreshToken) {
            result.refreshToken = tokenInfo.refreshToken;
          }
          if (tokenInfo.expiresAt !== undefined) {
            result.accessTokenExpiresAt = tokenInfo.expiresAt;
          }
          return result;
        },
        // Persist new tokens when refresh token rotation happens
        onTokenRefresh: async (tokens) => {
          logger.debug('Token refresh detected, persisting new tokens to keychain');
          const tokenInfo: Parameters<typeof storeKeychainOAuthTokenInfo>[2] = {
            accessToken: tokens.access_token,
            tokenType: tokens.token_type,
          };
          if (tokens.expires_in !== undefined) {
            tokenInfo.expiresIn = tokens.expires_in;
            tokenInfo.expiresAt = Math.floor(Date.now() / 1000) + tokens.expires_in;
          }
          if (tokens.refresh_token !== undefined) {
            tokenInfo.refreshToken = tokens.refresh_token;
          }
          if (tokens.scope !== undefined) {
            tokenInfo.scope = tokens.scope;
          }
          await storeKeychainOAuthTokenInfo(
            credentials.serverUrl,
            credentials.profileName,
            tokenInfo
          );

          // Update profile's refreshedAt timestamp (atomic operation)
          await updateAuthProfileRefreshedAt(credentials.serverUrl, credentials.profileName);
          logger.debug('Profile refreshedAt timestamp updated');

          logger.debug('New tokens persisted to keychain');
        },
      });
      logger.debug('OAuth token manager initialized');

      // Create auth provider for SDK transport (enables automatic token refresh)
      this.authProvider = new OAuthProvider({
        serverUrl: credentials.serverUrl,
        profileName: credentials.profileName,
        tokenManager: this.tokenManager,
        clientId: credentials.clientId,
      });
      logger.debug('OAuthProvider created for SDK transport (runtime mode)');
    } else if (credentials.refreshToken && !credentials.clientId) {
      logger.warn('Refresh token provided but client ID is missing - token refresh will not work');
    } else if (credentials.accessToken && !credentials.refreshToken) {
      // No refresh token available — use the access token as a static Bearer header.
      // This covers OAuth servers that don't issue refresh tokens.
      this.headers = {
        ...this.headers,
        Authorization: `Bearer ${credentials.accessToken}`,
      };
      logger.debug('Using OAuth access token as static Bearer header (no refresh token available)');
    }

    // Store headers if provided (used when no OAuth refresh token available)
    if (credentials.headers) {
      this.headers = {
        ...this.headers,
        ...credentials.headers,
      };
      logger.debug(`Stored headers "${Object.keys(this.headers).join(', ')}" in memory`);
    }

    // Store the proxy bearer token if provided (used by startProxyServer)
    if (credentials.proxyBearerToken) {
      this.proxyBearerToken = credentials.proxyBearerToken;
      logger.debug('Stored proxy bearer token in memory');
    }

    // Signal that auth credentials have been received (unblocks startup)
    if (this.authCredentialsResolver) {
      this.authCredentialsResolver();
      this.authCredentialsResolver = null;
    }
  }

  /**
   * Set x402 wallet received from CLI via IPC
   * The wallet private key is used for automatic payment signing
   */
  setX402Wallet(credentials: X402WalletCredentials): void {
    logger.info(`Received x402 wallet: ${credentials.address}`);
    this.x402Wallet = {
      privateKey: credentials.privateKey,
      address: credentials.address,
    };
    logger.debug('x402 wallet stored in memory');

    // Signal that wallet has been received (unblocks startup)
    if (this.x402WalletResolver) {
      this.x402WalletResolver();
      this.x402WalletResolver = null;
    }
  }

  /**
   * Get a valid access token, refreshing if necessary,
   * and update transport config with headers
   *
   * Priority:
   * 1. OAuth token manager (uses refresh token to get fresh access token)
   * 2. HTTP headers (static headers from --header flags)
   */
  private async updateTransportAuth(): Promise<ServerConfig> {
    const config = { ...this.options.serverConfig };

    // Only update auth for HTTP transport
    if (!config.url) {
      return config;
    }

    try {
      // Priority 1: Use OAuth token manager if available (can refresh tokens)
      if (this.tokenManager) {
        const token = await this.tokenManager.getValidAccessToken();
        config.headers = {
          ...this.headers, // Include any other headers from --header flags
          ...config.headers,
          Authorization: `Bearer ${token}`, // OAuth token takes priority
        };
        logger.debug('Updated transport config with fresh OAuth access token');
        return config;
      }

      // Priority 2: Use static headers if available
      if (this.headers) {
        config.headers = {
          ...config.headers,
          ...this.headers,
        };
        logger.debug(`Updated transport config with ${Object.keys(this.headers).length} headers`);
        return config;
      }
    } catch (error) {
      logger.error('Failed to get access token:', error);
      // Mark session as unauthorized if token refresh fails
      await this.markSessionStatusAndExit('unauthorized');
      throw error;
    }

    return config;
  }

  /**
   * Clean up log files for sessions that no longer exist
   * Runs asynchronously without blocking bridge startup
   */
  private runOrphanedLogCleanup(): void {
    // Run cleanup asynchronously without blocking startup
    void (async () => {
      try {
        logger.debug('Starting cleanup of orphaned log files');

        // Load active sessions
        const sessionsStorage = await loadSessions();
        const activeSessions = sessionsStorage.sessions;

        // Clean orphaned logs, skipping current session
        const deleted = await cleanupOrphanedLogFiles(activeSessions, {
          skipSession: this.options.sessionName,
        });

        logger.debug(`Finished cleanup of orphaned log files (deleted: ${deleted})`);
      } catch (error) {
        // Don't fail startup if cleanup fails
        logger.warn('Failed to clean up orphaned log files:', error);
      }
    })();
  }

  /**
   * Start the bridge process for a specific session.
   */
  async start(): Promise<void> {
    // 1. First, initialize file logger to see what's going on
    await initFileLogger(`bridge-${this.options.sessionName}.log`, {
      version: mcpcVersion,
      command: process.argv.slice(1).join(' '),
    });

    logger.info(`Bridge process starting for session: ${this.options.sessionName}`);
    if (this.options.insecure) {
      logger.warn('TLS certificate verification is disabled (--insecure)');
    }

    // 2. Clean up orphaned log files (runs asynchronously in background)
    this.runOrphanedLogCleanup();

    try {
      // 3. Create Unix socket server FIRST (so CLI can send auth credentials)
      await this.createSocketServer();

      // 4. Wait for auth credentials and/or x402 wallet from CLI via IPC
      // The CLI sends these immediately after detecting the socket file
      const ipcWaiters: Promise<void>[] = [];

      if (this.options.profileName) {
        logger.debug(`Waiting for auth credentials (profile: ${this.options.profileName})...`);
        this.authCredentialsReceived = new Promise<void>((resolve) => {
          this.authCredentialsResolver = resolve;
        });
        ipcWaiters.push(this.authCredentialsReceived);
      }

      if (this.options.x402) {
        logger.debug('Waiting for x402 wallet...');
        this.x402WalletReceived = new Promise<void>((resolve) => {
          this.x402WalletResolver = resolve;
        });
        ipcWaiters.push(this.x402WalletReceived);
      }

      if (ipcWaiters.length > 0) {
        // Wait with timeout (5 seconds should be plenty for local IPC)
        const timeoutPromise = new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error('Timeout waiting for IPC credentials')), 5000);
        });
        await Promise.race([Promise.all(ipcWaiters), timeoutPromise]);
        logger.debug('IPC credentials received, proceeding with MCP connection');
      }

      // 5. Connect to MCP server (now with auth credentials if provided)
      try {
        await this.connectToMcp();

        // 5b. Start proxy server if configured (BEFORE signaling ready)
        if (this.options.proxyConfig && this.client) {
          await this.startProxyServer();
        }

        // Signal that MCP client is ready (unblocks pending requests)
        // Only signal after both MCP connection AND proxy server are ready
        this.mcpClientReadyResolver();

        // Re-establish persisted resource subscriptions in the background —
        // failures are recorded per subscription, never block startup
        void this.restoreResourceSubscriptions();
      } catch (error) {
        // Signal that MCP connection or proxy startup failed (rejects pending requests with actual error)
        // Don't exit immediately - stay alive briefly so CLI can receive the error
        logger.error(
          'Bridge startup failed, will stay alive briefly for CLI to receive error:',
          error
        );
        // Classify the error so it propagates with the correct error type via IPC
        // Raw SDK errors (plain Error) would get default code 2 (ServerError) in sendError(),
        // losing the auth/session-expired distinction. Wrap as AuthError so the CLI
        // can detect it via `instanceof AuthError` after deserialization.
        let errorMsg = (error as Error).message || '';
        let classifiedError: Error = error as Error;
        // A resumed session rejected for a protocol mismatch means the server changed
        // protocol version underneath it (e.g. upgraded to 2026-07-28). The session
        // cannot be resumed anymore — treat it exactly like an expired one, so the CLI
        // tells the user to run `restart` (which reconnects without the session id)
        // instead of auto-reconnecting into the same rejection forever (#374).
        if (this.options.mcpSessionId && isProtocolMismatchError(errorMsg)) {
          errorMsg =
            `Session expired: the server no longer speaks protocol ` +
            `${this.options.protocolVersion ?? 'unknown'} that this session negotiated. ` +
            errorMsg;
          classifiedError = new ClientError(errorMsg);
        } else if (isAuthenticationError(errorMsg) && !(error instanceof AuthError)) {
          classifiedError = new AuthError(errorMsg);
        }
        // Append recent stdio server stderr so the CLI can show the user why
        // startup failed (common case: missing NODE_EXTRA_CA_CERTS etc.).
        if (this.stderrTail.count > 0) {
          classifiedError.message = `${classifiedError.message}\n\nRecent server stderr:\n${this.stderrTail.format()}`;
        }
        this.mcpClientReadyRejecter(classifiedError);

        // If the error was due to session ID rejection or auth failure, mark session status
        // User must explicitly use 'mcpc @session restart' or 'mcpc login' to recover
        if (
          isSessionExpiredError(errorMsg, {
            hadActiveSession: !!this.options.mcpSessionId,
          })
        ) {
          logger.warn('Session rejected by server (expired session ID), marking as expired');
          try {
            await updateSession(this.options.sessionName, { status: 'expired' });
          } catch (updateError) {
            logger.error('Failed to mark session as expired:', updateError);
          }
        } else if (isAuthenticationError(errorMsg)) {
          logger.warn('Server requires authentication, marking as unauthorized');
          try {
            await updateSession(this.options.sessionName, { status: 'unauthorized' });
          } catch (updateError) {
            logger.error('Failed to mark session as unauthorized:', updateError);
          }
        }

        // Set up signal handlers so we can be killed
        this.setupSignalHandlers();

        // Stay alive for 10 seconds to allow CLI to connect and get the error
        // Then shutdown gracefully
        setTimeout(() => {
          logger.info('Shutting down after startup failure');
          this.shutdown().catch(() => process.exit(1));
        }, 10_000);

        return; // Don't continue with keepalive etc
      }

      // 6. Start keepalive ping
      this.startKeepalive();

      // 7. Set up signal handlers
      this.setupSignalHandlers();

      logger.info('Bridge process started successfully');
    } catch (error) {
      logger.error('Failed to start bridge:', error);
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Record a stderr line from a stdio server: write it to the bridge log file
   * with a prefix, and keep a bounded tail for surfacing in connect failures.
   */
  private recordServerStderr(line: string): void {
    const stored = this.stderrTail.add(line);
    if (stored !== null) {
      logger.info(`[server stderr] ${stored}`);
    }
  }

  /**
   * Update session with notification timestamp for list changes
   */
  private async updateNotificationTimestamp(
    type: 'tools' | 'prompts' | 'resources'
  ): Promise<void> {
    const now = new Date().toISOString();
    await updateSession(this.options.sessionName, {
      notifications: {
        [type]: { listChangedAt: now },
      },
    });
    logger.debug(`Updated ${type} listChangedAt timestamp`);
  }

  /**
   * Connect to the MCP server
   */
  private async connectToMcp(): Promise<void> {
    // Session resumption exists only in the 2025 era — 2026-07-28 connections are
    // stateless and must negotiate the protocol on every connect. A stored session id
    // recorded with a modern protocol version is a leftover (typically from a server
    // that upgraded and dropped session support): replaying it makes the SDK skip
    // version negotiation, so every request goes out without the required `_meta`
    // envelope and is rejected, wedging the session in a reconnect loop (#374).
    if (
      this.options.mcpSessionId &&
      this.options.protocolVersion &&
      isModernProtocolVersion(this.options.protocolVersion)
    ) {
      logger.warn(
        `Ignoring the stored MCP session id: protocol ${this.options.protocolVersion} ` +
          `has no session resumption. Connecting with a fresh protocol negotiation.`
      );
      delete this.options.mcpSessionId;
      delete this.options.protocolVersion;
    }

    logger.debug('Connecting to MCP server...');
    logger.debug(`  authProvider: ${this.authProvider ? 'present' : 'NOT SET'}`);
    logger.debug(`  tokenManager: ${this.tokenManager ? 'present' : 'NOT SET'}`);
    logger.debug(`  headers: ${this.headers ? Object.keys(this.headers).join(', ') : 'none'}`);

    // Get transport config
    let serverConfig: ServerConfig;
    if (this.authProvider) {
      // TODO: feels like this code should (is?) be handled by updateTransportAuth
      // If we have an authProvider, DON'T add Authorization header to transport
      // Let the SDK's authProvider handle token refresh automatically
      // Only add non-OAuth headers (from --header flags) to transport
      serverConfig = { ...this.options.serverConfig };
      if (this.headers) {
        serverConfig.headers = { ...serverConfig.headers, ...this.headers };
        logger.debug(
          `Added non-OAuth headers "${Object.keys(this.headers).join(', ')}" to transport`
        );
      }
    } else {
      // No authProvider - use updateTransportAuth for static headers
      logger.debug('No authProvider - using updateTransportAuth for headers');
      serverConfig = await this.updateTransportAuth();
    }

    logger.debug('Building MCP client config...');
    logger.debug(`  this.authProvider is set: ${!!this.authProvider}`);
    logger.debug(`  this.x402Wallet is set: ${!!this.x402Wallet}`);
    if (this.authProvider) {
      logger.debug(`  authProvider type: ${this.authProvider.constructor.name}`);
    }

    // Build x402 fetch middleware if wallet is configured
    let customFetch: FetchLike | undefined;
    if (this.x402Wallet && serverConfig.url) {
      logger.debug('Creating x402 fetch middleware for payment signing');
      // We use a closure that defers tool lookup to the connected client
      // The client may not have tools cached yet at this point, but will
      // after it connects and receives the auto-refreshed tools list
      const wallet = this.x402Wallet;
      const getToolByName = (name: string): Tool | undefined => {
        // McpClient caches tools in-memory after the first listAllTools call
        return this.client?.getCachedTools()?.find((t: Tool) => t.name === name);
      };
      const { createX402FetchMiddleware } = await import('../lib/x402/fetch-middleware.js');
      customFetch = createX402FetchMiddleware(proxyFetch, {
        wallet,
        getToolByName,
        paymentCache: this.x402PaymentCache,
        ...(this.options.x402 && { schemePreference: this.options.x402 }),
      });
    }

    const clientConfig: CreateMcpClientOptions = {
      clientInfo: { name: 'mcpc', version: mcpcVersion },
      serverConfig,
      capabilities: buildClientCapabilities({
        clientCredentials: this.usesClientCredentials,
        enterpriseManagedAuth: this.usesIdJag,
      }),
      // Pass auth provider for automatic token refresh (HTTP transport only)
      ...(this.authProvider && { authProvider: this.authProvider }),
      // Pass session ID for resumption (HTTP transport only)
      ...(this.options.mcpSessionId && { mcpSessionId: this.options.mcpSessionId }),
      // Restore the previously negotiated protocol version on resumption: the SDK skips
      // the handshake when a session ID is supplied, so without this the reconnected
      // transport would not know which MCP-Protocol-Version header to send
      ...(this.options.mcpSessionId &&
        this.options.protocolVersion && { protocolVersion: this.options.protocolVersion }),
      // Pass x402 fetch middleware (HTTP transport only)
      ...(customFetch && { customFetch }),
      // Route stdio server stderr into the bridge log + tail buffer
      onStderrLine: (line: string) => this.recordServerStderr(line),
      listChanged: {
        tools: {
          // We handle refresh ourselves to fetch ALL pages (SDK only fetches the first page).
          // SDK's debounceMs still applies, preventing multiple rapid refreshes.
          autoRefresh: false,
          onChanged: () => {
            logger.debug('Tools list changed notification received, refreshing all tools...');
            if (this.client) {
              this.client.listAllTools({ refreshCache: true }).catch((err) => {
                logger.warn('Failed to refresh tools cache:', err);
              });
            }
            // Update session with notification timestamp
            this.updateNotificationTimestamp('tools').catch((err) => {
              logger.warn('Failed to update tools notification timestamp:', err);
            });
          },
        },
        resources: {
          autoRefresh: true,
          onChanged: (error: Error | null, resources: Resource[] | null) => {
            logger.debug('Resources list changed', { error, count: resources?.length });
            // Update session with notification timestamp
            this.updateNotificationTimestamp('resources').catch((err) => {
              logger.warn('Failed to update resources notification timestamp:', err);
            });
          },
        },
        prompts: {
          autoRefresh: true,
          onChanged: (error: Error | null, prompts: Prompt[] | null) => {
            logger.debug('Prompts list changed', { error, count: prompts?.length });
            // Update session with notification timestamp
            this.updateNotificationTimestamp('prompts').catch((err) => {
              logger.warn('Failed to update prompts notification timestamp:', err);
            });
          },
        },
      },
      autoConnect: true,
      verbose: this.options.verbose || false,
    };

    logger.debug('Calling createMcpClient with authProvider:', !!clientConfig.authProvider);
    if (clientConfig.mcpSessionId) {
      logger.info(
        `Attempting session resumption with MCP-Session-Id: ${clientConfig.mcpSessionId}`
      );
    }

    // Connect to MCP server - if session ID is rejected, this will throw
    // and the bridge will mark the session as expired (user must explicitly restart)
    this.client = await createMcpClient(clientConfig);

    logger.info('Connected to MCP server');
    logger.debug('MCP client created successfully, authProvider was:', !!clientConfig.authProvider);

    // Record server logging messages in the bridge log (viewable via `mcpc @session logs`)
    this.client.getSDKClient().setNotificationHandler('notifications/message', (notification) => {
      logger.info('[server log]', notification.params);
    });

    // Resource→file sync (resources-subscribe): load persisted subscriptions and
    // re-sync local files when the server announces a resource changed. Per the MCP
    // spec the updated notification carries only the URI — the client re-reads.
    const client = this.client;
    this.resourceSync = new ResourceSyncManager({
      readResource: (uri) => client.readResource(uri),
      persist: (entries) =>
        updateSession(this.options.sessionName, { resourceSubscriptions: entries }),
      logger: createLogger('resource-sync'),
    });
    const sessionData = await getSession(this.options.sessionName);
    this.resourceSync.load(sessionData?.resourceSubscriptions);
    this.client
      .getSDKClient()
      .setNotificationHandler('notifications/resources/updated', (notification) => {
        logger.debug(`Resource updated notification: ${notification.params.uri}`);
        this.resourceSync?.handleUpdated(notification.params.uri);
      });

    // Resuming a server-side session skips the initialize handshake, so remember the
    // values persisted by the connect that did perform it — they are the only source
    // of server capabilities and instructions for the rest of this bridge's life.
    if (this.options.mcpSessionId && sessionData) {
      this.resumedHandshakeDetails = {
        ...(sessionData.serverInfo && { serverInfo: sessionData.serverInfo }),
        ...(sessionData.capabilities && { capabilities: sessionData.capabilities }),
        ...(sessionData.instructions && { instructions: sessionData.instructions }),
        ...(sessionData.supportedVersions && {
          supportedVersions: sessionData.supportedVersions,
        }),
        ...(sessionData._meta && { _meta: sessionData._meta }),
      };
    }

    // Update session with protocol version, MCP session ID, and lastSeenAt
    const serverDetails = await this.getServerDetails();
    const newMcpSessionId = this.client.getMcpSessionId();

    // Detect session ID mismatch: we tried to resume but server did not return the
    // same session ID. This covers: server issued a different ID, or server did not
    // return any ID at all (e.g. session state lost). Either way the old session is gone.
    // Guarded by `this.options.mcpSessionId`, so stateless connections (which never resume,
    // since no session id was ever persisted) fall through without being marked expired.
    if (this.options.mcpSessionId && newMcpSessionId !== this.options.mcpSessionId) {
      logger.warn(
        `Server did not resume MCP session ` +
          `(expected ${this.options.mcpSessionId}, got ${newMcpSessionId ?? 'none'}). Marking as expired.`
      );
      throw new Error(
        `Session expired: server did not resume MCP session ` +
          `(expected ${this.options.mcpSessionId}, got ${newMcpSessionId ?? 'none'})`
      );
    }

    // Verify resumed session is actually functional by sending a ping.
    // The initialize handshake may succeed even when the server has lost session state,
    // causing the session to appear "live" until the first real request reveals it's expired.
    // Ping before marking as active so we never show a false "live" status.
    if (this.options.mcpSessionId) {
      logger.info('Verifying resumed session with ping...');
      await this.client.ping();
      logger.info('Session verification ping succeeded');
    }

    const sessionUpdate: Parameters<typeof updateSession>[1] = {
      lastSeenAt: new Date().toISOString(),
      status: 'active',
    };
    if (serverDetails.protocolVersion) {
      sessionUpdate.protocolVersion = serverDetails.protocolVersion;
    }
    // Persist the connection mode (derived by getServerDetails from the transport + session id) so
    // the session list can display it without an extra round-trip. stdio is always stateful; HTTP is
    // stateful/resumable iff the server assigned a session id, else stateless (2026-07-28 model).
    if (serverDetails.connectionMode) {
      sessionUpdate.connectionMode = serverDetails.connectionMode;
    }
    if (serverDetails.serverInfo) {
      sessionUpdate.serverInfo = serverDetails.serverInfo;
    }
    // Every version the server offered, and the discover result's `_meta` — 2026-07-28
    // connections only, so absent on legacy ones (see ServerDetails).
    if (serverDetails.supportedVersions) {
      sessionUpdate.supportedVersions = serverDetails.supportedVersions;
    }
    if (serverDetails._meta) {
      sessionUpdate._meta = serverDetails._meta;
    }
    // Capabilities and instructions come from the handshake only, so persist them for
    // future resumptions. They travel together: writing instructions unconditionally
    // here also clears stale text when a reconnect finds the server no longer sends any.
    if (serverDetails.capabilities) {
      sessionUpdate.capabilities = serverDetails.capabilities;
      const instructions = serverDetails.instructions;
      if (instructions && instructions.length > MAX_PERSISTED_INSTRUCTIONS_CHARS) {
        logger.debug(
          `Trimming server instructions before persisting them (${instructions.length} chars, ` +
            `limit ${MAX_PERSISTED_INSTRUCTIONS_CHARS})`
        );
      }
      sessionUpdate.instructions = instructions
        ? truncate(instructions, MAX_PERSISTED_INSTRUCTIONS_CHARS, TRIMMED_INSTRUCTIONS_NOTICE)
        : instructions;
    }
    if (newMcpSessionId) {
      sessionUpdate.mcpSessionId = newMcpSessionId;
      logger.info(`MCP-Session-Id saved for resumption: ${newMcpSessionId}`);
    } else if (sessionData?.mcpSessionId) {
      // The connection ended up without a session id although sessions.json holds one —
      // the server stopped assigning them, or the stored id was ignored above. Drop it,
      // or every later bridge start would keep trying to resume a session that is gone.
      sessionUpdate.mcpSessionId = undefined;
      logger.info('Cleared the stored MCP-Session-Id (this connection has none)');
    }
    await updateSession(this.options.sessionName, sessionUpdate);

    // Note: Token refresh is handled automatically by the SDK
    // The SDK calls authProvider.tokens() before each request,
    // which triggers OAuthTokenManager.getValidAccessToken() to refresh if needed

    // Pre-populate tools cache (used by x402 proactive signing and listAllTools IPC method)
    if (serverDetails.capabilities?.tools) {
      await this.client.listAllTools({ refreshCache: true }).catch((err) => {
        const errMsg = (err as Error).message || '';
        if (isSessionExpiredError(errMsg) || isAuthenticationError(errMsg)) {
          // Re-throw session/auth errors so they trigger proper status handling
          throw err;
        }
        logger.warn('Failed to pre-populate tools cache:', err);
      });
    }
  }

  /**
   * Server details for this connection, with the handshake-only fields restored from
   * sessions.json when the bridge resumed an existing server-side session. Resumption
   * reuses the session and skips `initialize`, so the SDK client would otherwise report
   * no server name, no capabilities and no instructions at all (see #325).
   *
   * Always use this instead of `client.getServerDetails()` inside the bridge.
   */
  private async getServerDetails(): Promise<ServerDetails> {
    if (!this.client) {
      throw new NetworkError('MCP client not connected');
    }
    const details = await this.client.getServerDetails();
    const persisted = this.resumedHandshakeDetails;
    if (!persisted) return details;

    if (!details.serverInfo && persisted.serverInfo) details.serverInfo = persisted.serverInfo;
    if (!details.capabilities && persisted.capabilities) {
      details.capabilities = persisted.capabilities;
    }
    if (!details.instructions && persisted.instructions) {
      details.instructions = persisted.instructions;
    }
    if (!details.supportedVersions && persisted.supportedVersions) {
      details.supportedVersions = persisted.supportedVersions;
    }
    if (!details._meta && persisted._meta) {
      details._meta = persisted._meta;
    }
    return details;
  }

  /**
   * Re-establish resource subscriptions persisted in sessions.json after a
   * bridge (re)start: re-subscribe on the server, then re-sync each local file
   * since updates may have been missed while the bridge was down. Per-entry
   * failures are recorded on the subscription (shown by `mcpc @session`) and
   * never tear down the session.
   */
  private async restoreResourceSubscriptions(): Promise<void> {
    const sync = this.resourceSync;
    const client = this.client;
    if (!sync || !client) return;
    const entries = sync.list();
    if (entries.length === 0) return;

    logger.info(`Restoring ${entries.length} resource subscription(s)...`);
    for (const entry of entries) {
      try {
        await client.subscribeResource(entry.uri);
      } catch (error) {
        const message = `Re-subscribe failed: ${(error as Error).message}`;
        logger.warn(`${message} (${entry.uri})`);
        await sync.recordError(entry.uri, message).catch(() => {});
        continue;
      }
      await sync.resync(entry.uri);
    }
  }

  /**
   * Start the proxy MCP server
   * Creates an HTTP server that forwards MCP requests to upstream client
   */
  private async startProxyServer(): Promise<void> {
    if (!this.options.proxyConfig || !this.client) {
      return;
    }

    const { host, port } = this.options.proxyConfig;

    // The proxy bearer token (if any) was delivered by the CLI over IPC, not read
    // from the keychain here — keeping bridge keychain access on the OAuth-refresh
    // path only (see #55).
    const bearerToken = this.proxyBearerToken;

    logger.info(`Starting proxy server on ${host}:${port}`);
    if (bearerToken) {
      logger.debug('Proxy server will require bearer token authentication');
    }

    // Get upstream server instructions to pass to proxy clients
    const serverDetails = await this.getServerDetails();
    const instructions = serverDetails.instructions;

    const proxyOptions: ConstructorParameters<typeof ProxyServer>[0] = {
      host,
      port,
      client: this.client,
      sessionName: this.options.sessionName,
      version: mcpcVersion,
    };
    if (bearerToken) {
      proxyOptions.bearerToken = bearerToken;
    }
    if (instructions) {
      proxyOptions.instructions = instructions;
    }

    this.proxyServer = new ProxyServer(proxyOptions);

    await this.proxyServer.start();
    logger.info(`Proxy server started at ${this.proxyServer.getAddress()}`);
  }

  /**
   * Start periodic keepalive ping to maintain connection
   */
  private startKeepalive(): void {
    logger.debug(`Starting keepalive ping every ${KEEPALIVE_INTERVAL_MILLIS / 1000}s`);

    // Send first ping soon after startup to detect stale sessions early
    // (e.g. session expired on server between auto-reconnect and first interval tick)
    const earlyPing = setTimeout(() => {
      this.sendKeepalivePing().catch(async (error) => {
        logger.error('Initial keepalive ping failed:', error);
        await this.handlePossibleExpiration(error as Error);
      });
    }, 5_000);
    earlyPing.unref();

    this.keepaliveInterval = setInterval(() => {
      this.sendKeepalivePing().catch(async (error) => {
        logger.error('Keepalive ping failed:', error);
        // If ping fails, the session might be expired - check and handle
        await this.handlePossibleExpiration(error as Error);
      });
    }, KEEPALIVE_INTERVAL_MILLIS);

    // Don't block process exit waiting for this interval
    this.keepaliveInterval.unref();
  }

  /**
   * Send a single keepalive ping to the MCP server
   */
  private async sendKeepalivePing(): Promise<void> {
    if (!this.client || this.isShuttingDown) {
      return;
    }

    logger.debug('Sending keepalive ping');
    await this.client.ping();
    logger.debug('Keepalive ping successful');

    // Update lastSeenAt on successful ping
    await this.updateLastSeenAt();
  }

  /**
   * Update lastSeenAt timestamp to track when server was last responsive
   */
  private async updateLastSeenAt(): Promise<void> {
    try {
      await updateSession(this.options.sessionName, {
        lastSeenAt: new Date().toISOString(),
      });
    } catch (error) {
      // Don't fail operations if timestamp update fails
      logger.error('Failed to update lastSeenAt:', error);
    }
  }

  /**
   * Check if an error indicates session expiration or auth failure and handle accordingly.
   * Session expiry is checked first since it's more specific (404/session-not-found),
   * while auth errors are broader (401/403/unauthorized) and could overlap.
   *
   * Skips application-level MCP errors (JSON-RPC errors from server handlers like
   * "tool not found") since these should never cause session status changes. Only
   * transport-level errors (HTTP 401/403/404) should trigger auth/expiry detection.
   *
   * For auth errors, if a token manager is available, we attempt to refresh the token
   * before giving up. This handles transient auth failures (e.g., expired access token
   * that can be refreshed) without unnecessarily killing the session.
   */
  private async handlePossibleExpiration(error: Error): Promise<void> {
    // ServerError wraps errors from mcp-client.ts methods. Check the original error
    // to distinguish application-level JSON-RPC errors (tool not found, etc.) from
    // transport-level errors (HTTP 401/403/404). The SDK's ProtocolError class (named
    // 'McpError' in SDK v1) indicates a JSON-RPC error response — these are
    // application-level and should be skipped.
    if (error instanceof ServerError) {
      const originalError = (error.details as { originalError?: Error } | undefined)?.originalError;
      if (
        originalError &&
        (originalError.name === 'ProtocolError' || originalError.name === 'McpError')
      ) {
        return;
      }
    }

    // Only treat a bare HTTP 404 as session expiry when this connection actually has a
    // server-assigned session id to lose. Stateless servers (2026-07-28) issue no id, so a
    // transient 404 there is a routing/path error, not an expired session — never mark such
    // a session "expired" (it cannot be, and there is nothing for `restart` to recover).
    const hadActiveSession = !!(this.options.mcpSessionId || this.client?.getMcpSessionId());
    let status: 'expired' | 'unauthorized' | null = null;
    if (
      isSessionExpiredError(error.message, { hadActiveSession }) ||
      // A protocol mismatch on a live server-side session means the server changed its
      // protocol version underneath it — the session cannot continue and cannot be
      // resumed, same as expiry (#374).
      (hadActiveSession && isProtocolMismatchError(error.message))
    ) {
      logger.warn('Session appears to be expired, marking as expired and shutting down');
      status = 'expired';
    } else if (isAuthenticationError(error.message)) {
      // If we have a token manager, try to refresh before giving up
      if (this.tokenManager) {
        try {
          logger.info(
            'Authentication error detected, attempting token refresh before giving up...'
          );
          await this.tokenManager.refreshAccessToken();
          logger.info('Token refresh succeeded — session will recover on next request');
          return;
        } catch (refreshError) {
          logger.warn('Token refresh also failed, marking session as unauthorized:', refreshError);
        }
      }
      logger.warn('Authentication rejected, marking session as unauthorized and shutting down');
      status = 'unauthorized';
    }
    if (status) {
      // Update session status synchronously so it's visible to CLI immediately
      try {
        await updateSession(this.options.sessionName, { status });
        logger.info(`Session ${this.options.sessionName} marked as ${status}`);
      } catch (e) {
        logger.error('Failed to update session status:', e);
      }
      // Delay shutdown so the error response socket.write() in the caller has
      // time to flush to the client before the process tears down.
      setTimeout(() => {
        this.shutdown().catch(() => process.exit(1));
      }, 100);
    }
  }

  /**
   * Mark the session with given status in sessions.json and exit
   */
  private async markSessionStatusAndExit(status: 'expired' | 'unauthorized'): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    try {
      await updateSession(this.options.sessionName, { status });
      logger.info(`Session ${this.options.sessionName} marked as ${status}`);
    } catch (error) {
      logger.error('Failed to update session status:', error);
    }

    // Gracefully shutdown
    await this.shutdown();
  }

  /**
   * Create socket server for IPC (Unix domain socket or Windows named pipe)
   */
  private async createSocketServer(): Promise<void> {
    // Ensure the socket's directory exists (for Unix sockets; Windows named pipes
    // don't need this). This is normally ~/.mcpc/bridges, but getSocketPath() may
    // relocate over-long paths to a short dir under the temp dir — create whichever
    // one applies.
    if (process.platform !== 'win32') {
      const socketDir = dirname(this.socketPath);
      if (socketDir === getShortSocketDir()) {
        // The temp-dir fallback lives in a world-writable location with a
        // predictable name — verify ownership/permissions before trusting it.
        await ensureSecureTempDir(socketDir);
      } else {
        await ensureDir(socketDir);
      }

      // Remove existing socket file if it exists (Unix only).
      // Fail on error
      if (await fileExists(this.socketPath)) {
        logger.debug(`Removing existing socket: ${this.socketPath}`);
        await unlink(this.socketPath);
      }
    }

    // Create server
    const server = createServer((socket) => this.handleConnection(socket));
    this.server = server;

    // Listen on socket/pipe
    await new Promise<void>((resolve, reject) => {
      server.listen(this.socketPath, () => {
        logger.info(`Socket server listening: ${this.socketPath}`);
        resolve();
      });

      server.on('error', (error) => {
        logger.error('Socket server error:', error);
        reject(error);
      });
    });
  }

  /**
   * Handle a new client connection
   */
  private handleConnection(socket: Socket): void {
    logger.debug('New client connected');
    this.connections.add(socket);

    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();

      if (buffer.length > MAX_BUFFER_SIZE) {
        logger.error(`IPC buffer exceeded ${MAX_BUFFER_SIZE} bytes, destroying socket`);
        socket.destroy();
        this.connections.delete(socket);
        return;
      }

      // Process complete JSON messages (newline-delimited)
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.trim()) {
          this.handleMessage(socket, line).catch((error) => {
            logger.error('Error handling message:', error);
          });
        }
      }
    });

    socket.on('end', () => {
      logger.debug('Client disconnected');
      this.connections.delete(socket);
    });

    socket.on('error', (error) => {
      logger.error('Socket error:', error);
      this.connections.delete(socket);
    });
  }

  /**
   * Handle an IPC message from the CLI
   */
  private async handleMessage(socket: Socket, data: string): Promise<void> {
    let messageId: string | undefined;

    try {
      const message = JSON.parse(data) as IpcMessage;
      messageId = message.id;

      logger.debug('Received message:', { type: message.type, method: message.method });

      // Handle different message types
      switch (message.type) {
        case 'request':
          await this.handleMcpRequest(socket, message);
          break;

        case 'shutdown':
          logger.info('Received shutdown request');
          if (message.id) {
            this.sendResponse(socket, { type: 'response', id: message.id });
          }
          await this.shutdown();
          break;

        case 'set-auth-credentials':
          if (message.authCredentials) {
            this.setAuthCredentials(message.authCredentials);
            if (message.id) {
              this.sendResponse(socket, {
                type: 'response',
                id: message.id,
                result: { success: true },
              });
            }
          } else {
            throw new ClientError('Missing authCredentials in set-auth-credentials message');
          }
          break;

        case 'set-x402-wallet':
          if (message.x402Wallet) {
            this.setX402Wallet(message.x402Wallet);
            if (message.id) {
              this.sendResponse(socket, {
                type: 'response',
                id: message.id,
                result: { success: true },
              });
            }
          } else {
            throw new ClientError('Missing x402Wallet in set-x402-wallet message');
          }
          break;

        default:
          throw new ClientError(`Unknown message type: ${message.type}`);
      }
    } catch (error) {
      logger.error('Failed to handle message:', error);
      this.sendError(socket, error as Error, messageId);
    }
  }

  /**
   * Handle a tool result that contains x402 payment-required data.
   * Signs a fresh payment, caches it, and retries the tool call once.
   *
   * Returns { handled: true, result } if payment was signed and retry succeeded.
   * Returns { handled: false } if the result is not a payment-required response.
   */
  private async handlePaymentRequiredRetry(
    toolName: string,
    toolResult: unknown,
    retryFn: () => Promise<unknown>
  ): Promise<{ handled: true; result: unknown } | { handled: false }> {
    if (!this.x402Wallet) return { handled: false };

    const {
      extractPaymentRequiredFromResult,
      extractAcceptFromPaymentRequired,
      recordPaymentRequiredTool,
    } = await import('../lib/x402/fetch-middleware.js');
    const paymentRequired = extractPaymentRequiredFromResult(toolResult);
    if (!paymentRequired) return { handled: false };

    const parsed = extractAcceptFromPaymentRequired(paymentRequired, this.options.x402);
    if (!parsed) {
      logger.warn('Payment-required tool result but could not extract supported payment terms');
      return { handled: false };
    }

    logger.debug('Payment-required tool result received, signing fresh payment and retrying...');

    // The challenge is the only proof that this tool is paid on servers that advertise no
    // _meta.x402 — without it the middleware would leave the retry unpaid (#365)
    recordPaymentRequiredTool(this.x402PaymentCache, toolName);

    // Invalidate cache and sign fresh
    this.x402PaymentCache.signature = null;
    try {
      const { signPayment } = await import('../lib/x402/signer.js');
      const signed = await signPayment({
        wallet: this.x402Wallet,
        accept: parsed.accept,
        resource: parsed.resource,
      });
      this.x402PaymentCache.signature = signed.paymentSignatureBase64;
      logger.debug(
        `Fresh payment signed for retry: $${signed.amountUsd.toFixed(6)} to ${signed.to} on ${signed.networkLabel}`
      );
    } catch (signError) {
      logger.warn('Failed to sign fresh payment for 402 retry:', signError);
      return { handled: false };
    }

    // Retry once with the new cached payment
    const result = await retryFn();
    return { handled: true, result };
  }

  /**
   * Forward an MCP request to the MCP server
   * Blocks until MCP client is connected, propagates connection errors to caller
   */
  private async handleMcpRequest(socket: Socket, message: IpcMessage): Promise<void> {
    logger.debug(`>>> handleMcpRequest: ${message.method} <<<`);

    // Wait for MCP client to be ready (blocks if still connecting, throws if connection failed)
    await this.mcpClientReady;

    if (!this.client) {
      // Should never happen after mcpClientReady resolves, but TypeScript needs this check
      throw new NetworkError('MCP client not connected');
    }

    if (!message.method) {
      throw new ClientError('Missing method in request');
    }

    // Log auth state before making request
    logger.debug(`  authProvider is set: ${!!this.authProvider}`);
    if (this.tokenManager) {
      const expiresInSecs = this.tokenManager.getSecondsUntilExpiry();
      logger.debug(`  token expires in: ${expiresInSecs} seconds`);
    }

    try {
      // Apply per-request timeout if provided (from CLI --timeout flag, in seconds →
      // milliseconds). The client reads the value synchronously when the routed method
      // is entered, and the finally below restores the baseline, so a one-off --timeout
      // never leaks into concurrent or later requests.
      if (message.timeoutSecs !== undefined) {
        this.client.setRequestTimeout(message.timeoutSecs * 1000);
      }

      let result: unknown;

      // Route to appropriate client method
      switch (message.method) {
        case 'ping':
          result = await this.client.ping();
          break;

        case 'discover':
          result = await this.client.discover();
          break;

        case 'listTools': {
          const cursor = message.params as string | undefined;
          result = await this.client.listTools(cursor);
          break;
        }

        case 'callTool': {
          const params = message.params as {
            name: string;
            arguments?: Record<string, unknown>;
            _meta?: Record<string, unknown>;
            useTask?: boolean;
            detach?: boolean;
          };

          // Helper to execute the tool call (used for initial attempt and 402 retry)
          // Capture client ref — guaranteed non-null by check at top of handleMcpRequest
          const client = this.client;

          // Refuse --task/--detach unless this connection can really run tasks. The CLI
          // checks first and reports the same reason; this is the backstop for direct
          // callers and for a capability that changed since that check. Falling through
          // to a plain tools/call would run the tool synchronously and hand --detach
          // callers a tool result where they expect a task ID.
          if (params.useTask) {
            client.assertTasksAvailable();
            if (!client.supportsTasksForToolCall()) {
              throw new ClientError(tasksUnsupportedByServerMessage());
            }
          }

          const executeToolCall = async (): Promise<unknown> => {
            if (params.useTask) {
              if (params.detach) {
                // Detached execution: start task and return task ID immediately
                const taskUpdate = await client.callToolDetached(
                  params.name,
                  params.arguments,
                  params._meta
                );
                this.activeTasks.set(taskUpdate.taskId, {
                  taskId: taskUpdate.taskId,
                  status: taskUpdate.status,
                  statusMessage: taskUpdate.statusMessage,
                  createdAt: taskUpdate.createdAt ?? new Date().toISOString(),
                  lastUpdatedAt: taskUpdate.lastUpdatedAt ?? new Date().toISOString(),
                } as Task);
                await this.persistActiveTask(taskUpdate.taskId, params.name);
                return taskUpdate;
              }

              // Task-augmented tool call: stream updates to requesting socket
              const onUpdate = (update: TaskUpdate): void => {
                this.activeTasks.set(update.taskId, {
                  taskId: update.taskId,
                  status: update.status,
                  statusMessage: update.statusMessage,
                  createdAt: update.createdAt ?? new Date().toISOString(),
                  lastUpdatedAt: update.lastUpdatedAt ?? new Date().toISOString(),
                } as Task);
                if (message.id) {
                  this.sendResponse(socket, {
                    type: 'task-update',
                    id: message.id,
                    taskUpdate: update,
                  });
                }
              };
              let taskId: string | undefined;
              const { wrappedOnUpdate } = this.persistActiveTaskOnCreate((update: TaskUpdate) => {
                taskId = update.taskId;
                onUpdate(update);
              }, params.name);
              try {
                return await client.callToolWithTask(
                  params.name,
                  params.arguments,
                  wrappedOnUpdate,
                  params._meta
                );
              } finally {
                for (const [tid, task] of this.activeTasks) {
                  if (
                    task.status === 'completed' ||
                    task.status === 'failed' ||
                    task.status === 'cancelled'
                  ) {
                    this.activeTasks.delete(tid);
                    await this.removePersistedTask(tid).catch(() => {});
                  }
                }
                if (taskId) {
                  await this.removePersistedTask(taskId).catch(() => {});
                }
              }
            }

            return client.callTool(params.name, params.arguments, params._meta);
          };

          // Execute with automatic x402 payment retry on payment-required tool results
          result = await executeToolCall();
          const retry = await this.handlePaymentRequiredRetry(params.name, result, executeToolCall);
          if (retry.handled) {
            result = retry.result;
          }
          break;
        }

        case 'listResources': {
          const cursor = message.params as string | undefined;
          result = await this.client.listResources(cursor);
          break;
        }

        case 'readResource': {
          const params = message.params as { uri: string };
          result = await this.client.readResource(params.uri);
          break;
        }

        case 'listResourceTemplates': {
          const cursor = message.params as string | undefined;
          result = await this.client.listResourceTemplates(cursor);
          break;
        }

        case 'subscribeResource': {
          // Subscribe + sync the resource to a local file: subscribe on the server,
          // download the current content, then keep rewriting the file on
          // notifications/resources/updated (see ResourceSyncManager).
          const params = message.params as { uri: string; filePath: string };
          if (!params?.uri || !params?.filePath) {
            throw new ClientError('subscribeResource requires uri and filePath');
          }
          if (!this.resourceSync) {
            throw new NetworkError('MCP client not connected');
          }
          // The resources.subscribe capability flag exists only in the 2025-era protocol.
          // On 2026-07-28 connections subscription support is signalled by the
          // subscriptions/listen acknowledgment instead, so let the subscribe attempt
          // decide there — it fails loudly when the server does not honor the URI.
          if (this.client.getProtocolEra() !== 'modern') {
            const details = await this.getServerDetails();
            if (!details.capabilities?.resources?.subscribe) {
              throw new ClientError(
                `Server does not support resource subscriptions (no resources.subscribe capability).\n` +
                  `To download the resource once instead, run:\n` +
                  `  mcpc ${this.options.sessionName} resources-read ${params.uri} -o <file>`
              );
            }
          }
          await this.client.subscribeResource(params.uri);
          try {
            result = await this.resourceSync.add(params.uri, params.filePath);
          } catch (error) {
            // Initial sync failed (bad path, unreadable resource) — roll back the
            // server-side subscription so no orphaned subscription keeps notifying
            await this.client.unsubscribeResource(params.uri).catch(() => {});
            throw error;
          }
          break;
        }

        case 'unsubscribeResource': {
          const params = message.params as { uri: string };
          if (!this.resourceSync) {
            throw new NetworkError('MCP client not connected');
          }
          // Remove the local subscription first (throws ClientError when unknown) —
          // this alone guarantees the file stops being rewritten. The synced file is kept.
          const entry = await this.resourceSync.remove(params.uri);
          // Best-effort server-side unsubscribe; local sync is already stopped, so a
          // server error (e.g. lost subscription state) must not fail the command.
          await this.client.unsubscribeResource(params.uri).catch((error) => {
            logger.warn(
              `Server unsubscribe failed for ${params.uri} (local sync stopped anyway):`,
              error
            );
          });
          result = { uri: params.uri, file: entry.filePath };
          break;
        }

        case 'listPrompts': {
          const cursor = message.params as string | undefined;
          result = await this.client.listPrompts(cursor);
          break;
        }

        case 'getPrompt': {
          const params = message.params as { name: string; arguments?: Record<string, string> };
          result = await this.client.getPrompt(params.name, params.arguments);
          break;
        }

        case 'setLoggingLevel': {
          const params = message.params as LoggingLevel;
          result = await this.client.setLoggingLevel(params);
          break;
        }

        case 'getServerDetails':
          result = await this.getServerDetails();
          break;

        case 'listTasks': {
          const cursor = message.params as string | undefined;
          result = await this.client.listTasks(cursor);
          break;
        }

        case 'getTask': {
          const params = message.params as { taskId: string };
          result = await this.client.getTask(params.taskId);
          break;
        }

        case 'getTaskResult': {
          const params = message.params as { taskId: string };
          result = await this.client.getTaskResult(params.taskId);
          break;
        }

        case 'cancelTask': {
          const params = message.params as { taskId: string };
          result = await this.client.cancelTask(params.taskId);
          break;
        }

        case 'pollTask': {
          const params = message.params as { taskId: string };
          const onUpdate = (update: TaskUpdate): void => {
            // Track active task
            this.activeTasks.set(update.taskId, {
              taskId: update.taskId,
              status: update.status,
              statusMessage: update.statusMessage,
              createdAt: update.createdAt ?? new Date().toISOString(),
              lastUpdatedAt: update.lastUpdatedAt ?? new Date().toISOString(),
            } as Task);
            // Send task update to requesting client
            if (message.id) {
              this.sendResponse(socket, {
                type: 'task-update',
                id: message.id,
                taskUpdate: update,
              });
            }
          };
          try {
            result = await this.client.pollTask(params.taskId, onUpdate);
          } finally {
            this.activeTasks.delete(params.taskId);
            await this.removePersistedTask(params.taskId).catch(() => {});
          }
          break;
        }

        case 'listAllTools': {
          const params = message.params as { refreshCache?: boolean } | undefined;
          result = await this.client.listAllTools(params);
          break;
        }

        default:
          throw new ClientError(`Unknown MCP method: ${message.method}`);
      }

      if (message.id) {
        this.sendResponse(socket, {
          type: 'response',
          id: message.id,
          result,
        });
      }
    } catch (error) {
      logger.error('Failed to forward MCP request to server:', error);

      // Update session status BEFORE sending error to CLI, so the status is
      // visible when the CLI (or test) checks sessions.json immediately after
      await this.handlePossibleExpiration(error as Error);

      this.sendError(socket, error as Error, message.id);
    } finally {
      if (message.timeoutSecs !== undefined) {
        this.client?.resetRequestTimeout();
      }
    }
  }

  // --- Active task persistence for crash recovery (stored in sessions.json) ---

  /**
   * Persist an active task to sessions.json for crash recovery
   */
  private async persistActiveTask(taskId: string, toolName: string): Promise<void> {
    try {
      const session = await getSession(this.options.sessionName);
      const activeTasks = { ...session?.activeTasks };
      activeTasks[taskId] = {
        taskId,
        toolName,
        createdAt: new Date().toISOString(),
      };
      await updateSession(this.options.sessionName, { activeTasks });
    } catch (error) {
      logger.warn(`Failed to persist active task ${taskId}:`, error);
    }
  }

  /**
   * Remove a persisted task (on completion/failure/cancellation)
   */
  private async removePersistedTask(taskId: string): Promise<void> {
    try {
      const session = await getSession(this.options.sessionName);
      if (session?.activeTasks?.[taskId]) {
        const activeTasks = { ...session.activeTasks };
        delete activeTasks[taskId];
        await updateSession(this.options.sessionName, {
          activeTasks: Object.keys(activeTasks).length > 0 ? activeTasks : {},
        });
      }
    } catch (error) {
      logger.warn(`Failed to remove persisted task ${taskId}:`, error);
    }
  }

  /**
   * Helper to wrap onUpdate callback with task persistence on first creation
   */
  private persistActiveTaskOnCreate(
    onUpdate: (update: TaskUpdate) => void,
    toolName: string
  ): { wrappedOnUpdate: (update: TaskUpdate) => void } {
    let persisted = false;
    const wrappedOnUpdate = (update: TaskUpdate): void => {
      if (!persisted) {
        persisted = true;
        this.persistActiveTask(update.taskId, toolName).catch(() => {});
      }
      onUpdate(update);
    };
    return { wrappedOnUpdate };
  }

  /**
   * Send a response message to the CLI
   */
  private sendResponse(socket: Socket, message: IpcMessage): void {
    const data = JSON.stringify(message) + '\n';
    socket.write(data);
  }

  /**
   * Send an error response to the CLI
   */
  private sendError(socket: Socket, error: Error, id?: string): void {
    const message: IpcMessage = {
      type: 'response',
      error: {
        code:
          error instanceof ClientError
            ? 1
            : error instanceof NetworkError
              ? 3
              : error instanceof AuthError
                ? 4
                : 2,
        message: error.message,
      },
    };

    if (id) {
      message.id = id;
    }

    this.sendResponse(socket, message);
  }

  /**
   * Set up signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    const handleSignal = (signal: string): void => {
      logger.info(`Received ${signal}, shutting down...`);
      this.shutdown().catch((error) => {
        logger.error('Error during shutdown:', error);
        process.exit(1);
      });
    };

    process.on('SIGTERM', () => handleSignal('SIGTERM'));
    process.on('SIGINT', () => handleSignal('SIGINT'));
  }

  /**
   * Gracefully shutdown the bridge
   */
  private async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;

    logger.info('Shutting down bridge...');

    await this.cleanup();

    process.exit(0);
  }

  /**
   * Clean up resources
   */
  private async cleanup(): Promise<void> {
    // Stop keepalive ping
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
      logger.debug('Keepalive interval stopped');
    }

    // Stop proxy server if running
    if (this.proxyServer) {
      try {
        await this.proxyServer.stop();
        this.proxyServer = null;
        logger.debug('Proxy server stopped');
      } catch (error) {
        logger.warn('Failed to stop proxy server:', error);
      }
    }

    // Close all client connections
    for (const socket of this.connections) {
      socket.end();
    }
    this.connections.clear();

    // Close socket server
    if (this.server) {
      const server = this.server;
      await new Promise<void>((resolve) => {
        server.close(() => {
          logger.debug('Socket server closed');
          resolve();
        });
      });

      // Remove socket file (Unix only - Windows named pipes don't leave files)
      // Safe because each bridge has a unique PID-based socket path.
      if (process.platform !== 'win32') {
        try {
          if (await fileExists(this.socketPath)) {
            await unlink(this.socketPath);
            logger.debug('Socket file removed');
          }
        } catch (error) {
          logger.warn('Failed to remove socket file:', error);
        }
      }
    }

    // Close MCP client
    if (this.client) {
      try {
        await this.client.close();
        logger.debug('MCP client closed');
      } catch (error) {
        logger.warn('Failed to close MCP client:', error);
      }
    }

    // Close file logger
    try {
      await closeFileLogger();
      logger.debug('File logger closed');
    } catch (error) {
      logger.warn('Failed to close file logger:', error);
    }
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Parse command line arguments
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error(
      'Usage: mcpc-bridge <sessionName> <transportConfigJson> [--verbose] [--profile <name>] [--proxy-host <host>] [--proxy-port <port>] [--mcp-session-id <id>] [--protocol-version <version>] [--x402 <auto|upto|exact>] [--insecure]'
    );
    process.exit(1);
  }

  const sessionName = args[0] as string;
  const transportConfigJson = args[1] as string;
  const verbose = args.includes('--verbose');

  // Parse --profile argument
  let profileName: string | undefined;
  const profileIndex = args.indexOf('--profile');
  if (profileIndex !== -1 && args[profileIndex + 1]) {
    profileName = args[profileIndex + 1];
  }

  // Parse --proxy-host and --proxy-port arguments
  let proxyConfig: ProxyConfig | undefined;
  const proxyHostIndex = args.indexOf('--proxy-host');
  const proxyPortIndex = args.indexOf('--proxy-port');
  if (proxyHostIndex !== -1 && proxyPortIndex !== -1) {
    const host = args[proxyHostIndex + 1];
    const port = parseInt(args[proxyPortIndex + 1] || '', 10);
    if (host && !isNaN(port)) {
      proxyConfig = { host, port };
    }
  }

  // Parse --mcp-session-id argument (for session resumption)
  let mcpSessionId: string | undefined;
  const mcpSessionIdIndex = args.indexOf('--mcp-session-id');
  if (mcpSessionIdIndex !== -1 && args[mcpSessionIdIndex + 1]) {
    mcpSessionId = args[mcpSessionIdIndex + 1];
  }

  // Parse --protocol-version argument (protocol version negotiated by the resumed session)
  let protocolVersion: string | undefined;
  const protocolVersionIndex = args.indexOf('--protocol-version');
  if (protocolVersionIndex !== -1 && args[protocolVersionIndex + 1]) {
    protocolVersion = args[protocolVersionIndex + 1];
  }

  // Parse `--x402 <scheme>` (CLI always spawns the bridge with an explicit value).
  let x402: X402SchemePreference | undefined;
  const x402Index = args.indexOf('--x402');
  if (x402Index !== -1) {
    const value = args[x402Index + 1];
    if (value === undefined || !(X402_SCHEME_PREFERENCES as readonly string[]).includes(value)) {
      console.error(
        `--x402 requires a scheme: ${X402_SCHEME_PREFERENCES.join('|')} (got ${value ?? '<missing>'})`
      );
      process.exit(1);
    }
    x402 = value as X402SchemePreference;
  }

  // Parse --insecure flag (skip TLS certificate verification)
  const insecure = args.includes('--insecure');

  // Set up HTTP proxy from environment variables (HTTPS_PROXY, HTTP_PROXY, NO_PROXY, and lowercase variants)
  // Also handle --insecure flag to disable TLS certificate verification
  await initProxy({ insecure });

  try {
    const bridgeOptions: BridgeOptions = {
      sessionName,
      serverConfig: JSON.parse(transportConfigJson) as ServerConfig,
      verbose,
    };
    if (profileName) {
      bridgeOptions.profileName = profileName;
    }
    if (proxyConfig) {
      bridgeOptions.proxyConfig = proxyConfig;
    }
    if (mcpSessionId) {
      bridgeOptions.mcpSessionId = mcpSessionId;
    }
    if (protocolVersion) {
      bridgeOptions.protocolVersion = protocolVersion;
    }
    if (x402) {
      bridgeOptions.x402 = x402;
    }
    if (insecure) {
      bridgeOptions.insecure = true;
    }

    const bridge = new BridgeProcess(bridgeOptions);

    await bridge.start();
  } catch (error) {
    console.error('Bridge failed to start:', error);
    process.exit(1);
  }
}

// Run main function
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
