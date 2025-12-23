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
} from '@modelcontextprotocol/sdk/types.js';

// Re-export core MCP types for external use
export type {
  Tool,
  Resource,
  Prompt,
  PromptArgument,
  Implementation,
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
};

// Re-export protocol version constants
export { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

/**
 * Server information (extracted from InitializeResult)
 */
export interface ServerInfo {
  name: string;
  version: string;
  websiteUrl?: string;
  title?: string;
}

/**
 * Transport types supported by mcpc
 */
export type TransportType = 'stdio' | 'http';

/**
 * Configuration for a transport connection
 */
export interface TransportConfig {
  type: TransportType;
  url?: string; // For HTTP transport
  command?: string; // For stdio transport
  args?: string[]; // For stdio transport
  env?: Record<string, string>; // Environment variables for stdio
  headers?: Record<string, string>; // HTTP headers
  timeoutMs?: number; // Timeout in milliseconds
}

/**
 * Session status
 * - active: Session is healthy and can be used
 * - expired: Server indicated session is no longer valid (e.g., 404 response)
 */
export type SessionStatus = 'active' | 'expired';

/**
 * Session data stored in sessions.json
 */
export interface SessionData {
  name: string;
  target: string; // URL or package name
  transport: TransportType;
  authProfile?: string; // Name of auth profile (for OAuth servers)
  pid?: number; // Bridge process PID
  socketPath?: string; // Unix socket path
  protocolVersion?: string; // Negotiated MCP version
  serverInfo?: {
    name: string;
    version: string;
  };
  status?: SessionStatus; // Session health status (default: active)
  createdAt: string;
  updatedAt: string;
}

/**
 * Sessions storage structure (sessions.json)
 */
export interface SessionsStorage {
  sessions: Record<string, SessionData>; // sessionName -> SessionData
}

/**
 * OAuth tokens (stored in auth profile for now, will move to keychain later)
 */
export interface OAuthTokens {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  expires_at?: number; // Unix timestamp when token expires
}

/**
 * Authentication profile data stored in auth-profiles.json
 * Only OAuth authentication is supported for profiles
 */
export interface AuthProfile {
  name: string;
  serverUrl: string;
  authType: 'oauth';
  // OAuth fields
  oauthIssuer: string;
  scopes?: string[];
  authenticatedAt?: string;
  expiresAt?: string;
  // OAuth tokens (TODO: move to keychain)
  tokens?: OAuthTokens;
  // Metadata
  createdAt: string;
  updatedAt: string;
}

/**
 * Auth profiles storage structure (auth-profiles.json)
 */
export interface AuthProfilesStorage {
  profiles: Record<string, Record<string, AuthProfile>>; // serverUrl -> profileName -> AuthProfile
}

/**
 * IPC message types for CLI-bridge communication
 */
export type IpcMessageType = 'request' | 'response' | 'health-check' | 'health-ok' | 'shutdown' | 'notification';

/**
 * Notification types from MCP server
 */
export type NotificationType =
  | 'tools/list_changed'
  | 'resources/list_changed'
  | 'resources/updated'
  | 'prompts/list_changed'
  | 'progress'
  | 'logging/message';

/**
 * Notification data
 */
export interface NotificationData {
  method: NotificationType;
  params?: unknown;
}

/**
 * IPC message structure
 */
export interface IpcMessage {
  type: IpcMessageType;
  id?: string; // Request ID for correlation
  method?: string; // MCP method name
  params?: unknown; // Method parameters
  result?: unknown; // Response result
  notification?: NotificationData; // Notification data (for type='notification')
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Target resolution result
 */
export type TargetResolution =
  | {
      type: 'session';
      name: string;
    }
  | {
      type: 'http';
      url: string;
    }
  | {
      type: 'package';
      path: string;
      command: string;
      args?: string[];
    }
  | {
      type: 'config';
      name: string;
      config: TransportConfig;
    };

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
  timeout?: number;
  verbose?: boolean;
  hideTarget?: boolean; // Suppress "[Using session: @name]" prefix (used in interactive shell)
}

/**
 * Log levels matching MCP SDK
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Configuration file format (compatible with Claude Desktop)
 */
export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Individual server configuration
 */
export interface McpServerConfig {
  url?: string; // For HTTP servers
  command?: string; // For stdio servers
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  timeout?: number;
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

  // Server information
  // Note: These return Promises because SessionClient must do IPC to get them from bridge
  // McpClient has them cached locally but returns Promises for interface consistency
  getServerCapabilities(): Promise<ServerCapabilities | undefined>;
  getServerVersion(): Promise<Implementation | undefined>;
  getInstructions(): Promise<string | undefined>;
  getProtocolVersion(): Promise<string | undefined>;

  // MCP operations
  ping(): Promise<void>;
  listTools(cursor?: string): Promise<ListToolsResult>;
  callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  listResources(cursor?: string): Promise<ListResourcesResult>;
  listResourceTemplates(cursor?: string): Promise<ListResourceTemplatesResult>;
  readResource(uri: string): Promise<ReadResourceResult>;
  subscribeResource(uri: string): Promise<void>;
  unsubscribeResource(uri: string): Promise<void>;
  listPrompts(cursor?: string): Promise<ListPromptsResult>;
  getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult>;
  setLoggingLevel(level: LoggingLevel): Promise<void>;
}
