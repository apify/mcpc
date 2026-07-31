/**
 * Type definitions for mcpc
 * Re-exports MCP SDK types and defines additional application-specific types
 */

// Import types for use in interface definitions
import type {
  Tool,
  Resource,
  Prompt,
  PromptArgument,
  Implementation,
  DiscoverResult,
  ClientCapabilities,
  ServerCapabilities,
  InitializeRequest,
  InitializeResult,
  CallToolRequest,
  CallToolResult,
  ListToolsRequest,
  ListToolsResult,
  ListResourcesRequest,
  ListResourcesResult,
  ReadResourceRequest,
  ReadResourceResult,
  ListPromptsRequest,
  ListPromptsResult,
  GetPromptRequest,
  GetPromptResult,
  SubscribeRequest,
  UnsubscribeRequest,
  LoggingLevel,
  ListResourceTemplatesResult,
  Task,
  GetTaskResult,
  ListTasksResult,
  CancelTaskResult,
} from '@modelcontextprotocol/client';

/**
 * A single resource template entry. The SDK v2 does not export this type directly,
 * so it is derived from the list result it appears in.
 */
export type ResourceTemplate = ListResourceTemplatesResult['resourceTemplates'][number];

// Re-export core MCP types for external use
export type {
  Tool,
  Resource,
  Prompt,
  PromptArgument,
  Implementation,
  DiscoverResult,
  ClientCapabilities,
  ServerCapabilities,
  InitializeRequest,
  InitializeResult,
  CallToolRequest,
  CallToolResult,
  ListToolsRequest,
  ListToolsResult,
  ListResourcesRequest,
  ListResourcesResult,
  ReadResourceRequest,
  ReadResourceResult,
  ListPromptsRequest,
  ListPromptsResult,
  GetPromptRequest,
  GetPromptResult,
  SubscribeRequest,
  UnsubscribeRequest,
  LoggingLevel,
  Task,
  GetTaskResult,
  ListTasksResult,
  CancelTaskResult,
};

/** Keepalive ping interval in milliseconds (30 seconds) */
export const KEEPALIVE_INTERVAL_MILLIS = 30_000;

/** Threshold for considering a session disconnected (bridge alive but server unreachable) */
export const DISCONNECTED_THRESHOLD_MILLIS = 2 * KEEPALIVE_INTERVAL_MILLIS + 5000; // ~2 missed pings + 5s buffer

/**
 * Upper bound on server instructions persisted in sessions.json (see `SessionData.instructions`).
 * The file is read by every mcpc command, so oversized instructions are trimmed rather than
 * slowing down the whole CLI.
 */
export const MAX_PERSISTED_INSTRUCTIONS_CHARS = 32_768;

/** Marks the end of server instructions trimmed to MAX_PERSISTED_INSTRUCTIONS_CHARS. */
export const TRIMMED_INSTRUCTIONS_NOTICE = '\n\n[... trimmed excessive length]';

/** Valid x402 scheme preferences. Canonical source for CLI validation and type-narrowing. */
export const X402_SCHEME_PREFERENCES = ['auto', 'upto', 'exact'] as const;
export type X402SchemePreference = (typeof X402_SCHEME_PREFERENCES)[number];

/**
 * Configuration for a connection to MCP server
 * Used both for config file format and internal representation
 */
export interface ServerConfig {
  url?: string; // Mandatory tor http transport
  headers?: Record<string, string>; // For http transport
  command?: string; // Mandatory for stdio transport
  args?: string[]; // For stdio transport
  env?: Record<string, string>; // Environment variables for stdio transport
  timeout?: number; // Request timeout in SECONDS (field name kept as `timeout` for mcp.json / sessions.json compatibility)
  protocolVersion?: string; // Pin the MCP protocol version (strict, no fallback; absent = auto-negotiate)
}

/**
 * Configuration for proxy MCP server
 * When enabled, bridge launches an HTTP MCP server that forwards requests
 * to upstream server without exposing original auth tokens
 */
export interface ProxyConfig {
  host: string; // Host to bind proxy server (default: 127.0.0.1)
  port: number; // Port to bind proxy server
}

/**
 * Session status
 * - active: Session is healthy and can be used
 * - connecting: Bridge is starting up for the first time (initial connect in progress)
 * - reconnecting: Bridge crashed and is being automatically restarted
 * - unauthorized: Server rejected authentication (401/403) or token refresh failed. Recovery: login then restart.
 * - expired: Server indicated session is no longer valid (e.g., 404 response). Recovery: restart.
 * - crashed: Bridge process crashed, session might or might not be usable. Bridge will be restarted on next command.
 */
export type SessionStatus =
  'active' | 'connecting' | 'reconnecting' | 'unauthorized' | 'expired' | 'crashed';

/**
 * The connection's session model — whether the MCP connection carries server-side session state.
 * - stateful: a persistent connection — a stdio child process, or a Streamable HTTP
 *   server that assigned a session id (legacy `initialize`, or the optional
 *   `sessions/create` in 2026-07-28+), in which case it is resumable via `MCP-Session-Id`.
 * - stateless: a Streamable HTTP server that assigned no session id (the `2026-07-28`
 *   model where any request may hit any server instance). Not resumable; cannot "expire".
 * - unknown: not yet determined (e.g. before the first successful connect).
 * Derived at connect time from the transport and the presence of a session id.
 */
export type ConnectionMode = 'stateful' | 'stateless' | 'unknown';

/**
 * Transport carrying the MCP connection: a local child process speaking over stdin/stdout,
 * or Streamable HTTP. Derived from the live transport, so it reflects what is actually in
 * use rather than what the config asked for.
 */
export type TransportKind = 'stdio' | 'streamable-http';

/**
 * Notification timestamps for list change events
 * Tracks when the server last notified about changes to tools, prompts, or resources
 */
export interface SessionNotifications {
  tools?: {
    listChangedAt?: string; // ISO 8601 timestamp of last tools/list_changed notification
  };
  prompts?: {
    listChangedAt?: string; // ISO 8601 timestamp of last prompts/list_changed notification
  };
  resources?: {
    listChangedAt?: string; // ISO 8601 timestamp of last resources/list_changed notification
  };
}

/**
 * Session data stored in sessions.json
 */
export interface SessionData {
  name: string;
  server: ServerConfig; // Transport configuration (header values redacted to "<redacted>")
  profileName?: string; // Name of auth profile (for OAuth servers)
  /**
   * x402 auto-payment scheme preference. Presence enables x402 for the session;
   * the value is the preference (`auto` = prefer upto, fall back to exact).
   * Absent / undefined means x402 is disabled.
   */
  x402?: X402SchemePreference;
  insecure?: boolean; // Skip TLS certificate verification
  pid?: number; // Bridge process PID
  protocolVersion?: string; // Negotiated MCP version
  /**
   * Every protocol version the server advertised in its `server/discover` result
   * (2026-07-28 connections only — see `ServerDetails.supportedVersions`).
   */
  supportedVersions?: string[];
  mcpSessionId?: string; // Server-assigned MCP session ID for resumption (stateful Streamable HTTP only)
  connectionMode?: ConnectionMode; // Whether the connection carries server-side session state (derived at connect)
  /** Server identity, as reported by the handshake (`initialize`) or `server/discover`. */
  serverInfo?: Implementation;
  /**
   * Server capabilities reported by the initialize handshake. Persisted because a
   * resumed session reuses the server-side session and therefore skips the handshake,
   * leaving the client with no capabilities of its own.
   */
  capabilities?: ServerCapabilities;
  /**
   * Server instructions reported by the initialize handshake, persisted alongside
   * `capabilities`. Trimmed to {@link MAX_PERSISTED_INSTRUCTIONS_CHARS} (sessions.json is
   * read on every command), and omitted when the server sends none.
   */
  instructions?: string | undefined;
  /**
   * `_meta` of the server's `server/discover` result, verbatim (2026-07-28 connections
   * only — see `ServerDetails._meta`). Persisted alongside `capabilities` so a resumed
   * session can still report it.
   */
  _meta?: Record<string, unknown>;
  status?: SessionStatus; // Session health status (default: active)
  proxy?: ProxyConfig; // Proxy server configuration (if enabled)
  notifications?: SessionNotifications; // Last list change notification timestamps
  activeTasks?: Record<string, ActiveTaskEntry>; // Active async tasks for crash recovery
  resourceSubscriptions?: Record<string, ResourceSubscriptionEntry>; // Resource→file syncs, keyed by URI
  // Timestamps (ISO 8601 strings)
  createdAt: string; // When the session was created
  lastSeenAt?: string; // Last successful server response (ping, command, etc.)
  lastConnectionAttemptAt?: string; // Last connection/reconnection attempt (ISO 8601, for cooldown)
}

/**
 * Entry for an active async task persisted for crash recovery
 */
export interface ActiveTaskEntry {
  taskId: string;
  toolName: string;
  createdAt: string;
}

/**
 * A resource subscription that keeps a local file in sync with a server resource.
 * Created by `resources-subscribe <uri> <file>`. The bridge re-reads the resource
 * and rewrites the file whenever the server sends `notifications/resources/updated`.
 * Persisted in sessions.json so subscriptions survive bridge restarts.
 */
export interface ResourceSubscriptionEntry {
  uri: string;
  filePath: string; // Absolute path of the local sync target
  subscribedAt: string; // ISO 8601
  lastSyncedAt?: string; // ISO 8601 — last successful file write
  lastError?: string; // Last sync/re-subscribe failure (cleared on next success)
}

/**
 * Result of subscribing a resource to a local file (returned by the bridge)
 */
export interface ResourceSyncResult {
  uri: string;
  file: string; // Absolute path of the local sync target
  bytes: number; // Size of the synced content in bytes
  mimeType?: string;
}

/**
 * Result of unsubscribing a resource (returned by the bridge; the file is kept)
 */
export interface ResourceUnsubscribeResult {
  uri: string;
  file: string; // Absolute path of the local file that is kept
}

/**
 * Sessions storage structure (sessions.json)
 */
export interface SessionsStorage {
  sessions: Record<string, SessionData>; // sessionName -> SessionData
}

/**
 * OAuth grant type used by a profile.
 * - authorization_code: interactive, browser-based flow (the default; assumed when absent)
 * - client_credentials: machine-to-machine flow (no user), per the MCP extension
 *   `io.modelcontextprotocol/oauth-client-credentials`
 * - id_jag: enterprise-managed authorization (SEP-990): SSO at the enterprise IdP,
 *   then identity-assertion JWT authorization grants (ID-JAG) for the MCP server,
 *   per the MCP extension `io.modelcontextprotocol/enterprise-managed-authorization`
 */
export type OAuthGrant = 'authorization_code' | 'client_credentials' | 'id_jag';

/**
 * Authentication profile data stored in ~/.mcpc/profiles.json
 * Only OAuth authentication is supported for profiles
 * NOTE: Tokens and client-credentials secrets are stored securely in the OS
 * keychain, not in this file
 */
export interface AuthProfile {
  name: string;
  serverUrl: string;
  authType: 'oauth';
  /**
   * OAuth grant the profile authenticates with. Absent ⇒ 'authorization_code'
   * (backward compatible with profiles written before client-credentials support).
   */
  oauthGrant?: OAuthGrant;
  // OAuth metadata
  oauthIssuer: string;
  /** Enterprise IdP issuer URL (id_jag grant only). */
  idpIssuer?: string;
  scopes?: string[];
  // User info (from OIDC id_token, if available)
  userEmail?: string;
  userName?: string;
  userSubject?: string; // 'sub' claim - unique user identifier
  // Timestamps (ISO 8601 strings)
  createdAt: string;
  authenticatedAt?: string; // Last time the token was successfully used for authentication
  refreshedAt?: string; // Last time the token was refreshed
}

/**
 * Auth profiles storage structure (~/.mcpc/profiles.json)
 */
export interface AuthProfilesStorage {
  profiles: Record<string, Record<string, AuthProfile>>; // serverUrl -> profileName -> AuthProfile
}

/**
 * Enterprise-managed authorization (SEP-990) material for the `id_jag` grant.
 * Stored as one keychain blob per profile and delivered to the bridge via IPC.
 * The bridge exchanges `idToken` at the IdP for an ID-JAG (RFC 8693 token
 * exchange) and the ID-JAG at the MCP authorization server for an access token
 * (RFC 7523 jwt-bearer) — both handled by the MCP SDK.
 */
export interface IdJagCredentials {
  /** Enterprise IdP issuer URL. */
  idpIssuer: string;
  /** IdP token endpoint, discovered and pinned at login so the bridge never re-discovers. */
  idpTokenEndpoint: string;
  /** Client pre-registered at the enterprise IdP. */
  idpClientId: string;
  /** IdP client secret (absent for public IdP clients). */
  idpClientSecret?: string;
  /** Current OIDC ID token from the IdP — the subject of the RFC 8693 exchange. */
  idToken: string;
  /** ID token expiry (`exp` claim, unix seconds). */
  idTokenExpiresAt?: number;
  /** IdP refresh token; renews the ID token when the IdP granted offline access. */
  idpRefreshToken?: string;
  /** Client registered at the MCP authorization server. */
  mcpClientId: string;
  /** Secret for the MCP authorization server client (required by the SDK provider). */
  mcpClientSecret: string;
  /** Space-separated scopes requested for the MCP server. */
  scope?: string;
}

/**
 * IPC message types for CLI-bridge communication
 */
export type IpcMessageType =
  'request' | 'response' | 'shutdown' | 'task-update' | 'set-auth-credentials' | 'set-x402-wallet';

/**
 * Auth credentials sent from CLI to bridge via IPC
 * Supports both OAuth (with refresh token) and HTTP headers
 */
export interface AuthCredentials {
  serverUrl: string;
  profileName: string;
  // OAuth credentials (for refresh flow)
  clientId?: string;
  refreshToken?: string;
  // OAuth access token (used as static Bearer token when no refresh token available)
  accessToken?: string;
  /**
   * OAuth grant for this profile. When 'client_credentials', the bridge builds an
   * SDK client-credentials provider from the fields below instead of using the
   * refresh-token / access-token flow above.
   */
  oauthGrant?: OAuthGrant;
  // Client-credentials grant material (machine-to-machine; sent via IPC, never CLI args)
  clientSecret?: string; // client_secret_basic variant
  privateKeyPem?: string; // private_key_jwt variant (RFC 7523): PEM-encoded signing key
  keyAlg?: string; // JWT signing algorithm for the private_key_jwt variant (e.g. RS256)
  scope?: string; // space-separated scopes requested by the client-credentials grant
  tokenEndpoint?: string; // explicit token endpoint (--token-endpoint); bypasses discovery
  // Enterprise-managed authorization material (id_jag grant; sent via IPC, never CLI args)
  idJag?: IdJagCredentials;
  // HTTP headers (from --header flags, stored in keychain)
  headers?: Record<string, string>;
  // Bearer token the bridge's proxy server requires (from --proxy-bearer-token).
  // Read by the CLI before spawn and delivered via IPC so the bridge never reads it
  // from the keychain itself — keeping the bridge's only keychain access on the
  // sanctioned OAuth-refresh path (see #55).
  proxyBearerToken?: string;
}

/**
 * x402 wallet credentials sent from CLI to bridge via IPC
 */
export interface X402WalletCredentials {
  address: string;
  privateKey: string; // Hex with 0x prefix
}

/**
 * Task status update sent from bridge to CLI during task-augmented tool calls
 */
export interface TaskUpdate {
  taskId: string;
  status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';
  statusMessage?: string;
  progressMessage?: string; // Message from notifications/progress
  progress?: number; // Current progress value from notifications/progress
  progressTotal?: number; // Total progress value from notifications/progress
  createdAt?: string;
  lastUpdatedAt?: string;
}

/**
 * IPC message structure
 */
export interface IpcMessage {
  type: IpcMessageType;
  id?: string; // Request ID for correlation
  method?: string; // MCP method name
  params?: unknown; // Method parameters
  timeoutSecs?: number; // Per-request timeout in seconds (overrides default)
  result?: unknown; // Response result
  taskUpdate?: TaskUpdate; // Task progress update (for type='task-update')
  authCredentials?: AuthCredentials; // Auth credentials (for type='set-auth-credentials')
  x402Wallet?: X402WalletCredentials; // x402 wallet (for type='set-x402-wallet')
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Output format modes
 */
export type OutputMode = 'human' | 'json';

/**
 * Standard options passed to command handlers
 */
export interface CommandOptions {
  outputMode: OutputMode;
  config?: string;
  headers?: string[];
  timeoutSecs?: number; // Per-request timeout in seconds (from --timeout)
  verbose?: boolean;
  insecure?: boolean; // Skip TLS certificate verification (for self-signed certs)
  hideTarget?: boolean; // Suppress session info prefix
  schema?: string; // Path to expected schema file for validation
  schemaMode?: 'strict' | 'compatible' | 'ignore'; // Schema validation mode
  maxChars?: number; // Maximum output characters for tool/prompt results (truncate if exceeded)
}

/**
 * Log levels matching MCP SDK
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Configuration file format (compatible with Claude Desktop)
 */
export interface McpConfig {
  mcpServers: Record<string, ServerConfig>;
}

/**
 * x402 wallet data stored in ~/.mcpc/wallets.json
 * Only a single wallet is supported (no names needed)
 */
export interface WalletData {
  address: string;
  privateKey: string; // Hex string starting with 0x
  createdAt: string; // ISO 8601
}

/**
 * Wallets storage structure (~/.mcpc/wallets.json)
 * Versioned for future migration (e.g. multi-wallet support)
 */
export interface WalletsStorage {
  version: 1;
  wallet?: WalletData;
}

/**
 * Combined server details returned by getServerDetails()
 *
 * One era-neutral shape for both handshakes: the fields that MCP `InitializeResult`
 * (2025-11-25 `initialize`) and `DiscoverResult` (2026-07-28 `server/discover`) have in
 * common, plus the discover-only `supportedVersions` and `_meta`, plus two fields mcpc
 * derives itself (`connectionMode`, `transport`). On a 2026-07-28 connection the result
 * satisfies both schemas: `serverInfo` is lifted out of the discover result's `_meta`, and
 * `protocolVersion` is the version actually negotiated (the discover result only lists the
 * versions on offer).
 *
 * Fetched once during initialization, cached locally
 */
export interface ServerDetails {
  /** Negotiated protocol version */
  protocolVersion?: string;
  /**
   * Every protocol version the server advertises (`DiscoverResult.supportedVersions`).
   * 2026-07-28 connections only: the legacy `initialize` handshake reports nothing but the
   * single version it agreed on.
   */
  supportedVersions?: string[];
  /** Server capabilities */
  capabilities?: ServerCapabilities;
  /** Server implementation details (name, version, etc.) - matches MCP serverInfo field */
  serverInfo?: Implementation;
  /** Server-provided instructions for the client */
  instructions?: string;
  /**
   * `_meta` of the server's `server/discover` result, verbatim. 2026-07-28 connections
   * only (the SDK does not surface the legacy `initialize` result's `_meta`). Holds the
   * spec's `io.modelcontextprotocol/serverInfo` — the identity 2026-07-28 servers stamp on
   * every response, lifted into `serverInfo` above — plus any extension metadata the
   * server attached to it.
   */
  _meta?: Record<string, unknown>;
  /** Whether the connection carries server-side session state (derived from transport + session id) */
  connectionMode?: ConnectionMode;
  /** Transport carrying the connection (derived from the live transport) */
  transport?: TransportKind;
}

/**
 * Common interface for MCP clients
 * Both McpClient (direct SDK wrapper) and SessionClient (bridge IPC wrapper) implement this
 *
 * Note: Server info methods return Promises to accommodate SessionClient's IPC calls.
 * McpClient wraps synchronous SDK calls in resolved Promises for consistency.
 */
export interface IMcpClient {
  // Connection management
  close(): Promise<void>;

  // Server information (capabilities, instructions, version etc.)
  // single call returns all info to avoid multiple IPC roundtrips)
  getServerDetails(): Promise<ServerDetails>;

  // MCP operations
  ping(): Promise<void>;
  /**
   * Live `server/discover` request (2026-07-28+ only — throws on legacy connections).
   * Unlike getServerDetails(), which reports the connection's handshake snapshot.
   */
  discover(): Promise<DiscoverResult>;
  listTools(cursor?: string): Promise<ListToolsResult>;
  listAllTools(options?: { refreshCache?: boolean }): Promise<ListToolsResult>;
  callTool(
    name: string,
    args?: Record<string, unknown>,
    meta?: Record<string, unknown>
  ): Promise<CallToolResult>;
  listResources(cursor?: string): Promise<ListResourcesResult>;
  listResourceTemplates(cursor?: string): Promise<ListResourceTemplatesResult>;
  readResource(uri: string): Promise<ReadResourceResult>;
  // Note: resource subscriptions (resources-subscribe/-unsubscribe) are not part of this
  // interface — they sync files via the persistent bridge process and live on SessionClient.
  // McpClient keeps the raw protocol ops (subscribeResource/unsubscribeResource) for the bridge.
  listPrompts(cursor?: string): Promise<ListPromptsResult>;
  getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult>;
  setLoggingLevel(level: LoggingLevel): Promise<void>;

  // Task operations (async tool execution)
  callToolWithTask(
    name: string,
    args?: Record<string, unknown>,
    onUpdate?: (update: TaskUpdate) => void,
    meta?: Record<string, unknown>
  ): Promise<CallToolResult>;
  callToolDetached(
    name: string,
    args?: Record<string, unknown>,
    meta?: Record<string, unknown>
  ): Promise<TaskUpdate>;
  pollTask(taskId: string, onUpdate?: (update: TaskUpdate) => void): Promise<CallToolResult>;
  listTasks(cursor?: string): Promise<ListTasksResult>;
  getTask(taskId: string): Promise<GetTaskResult>;
  getTaskResult(taskId: string): Promise<CallToolResult>;
  cancelTask(taskId: string): Promise<CancelTaskResult>;
}
