/**
 * Type definitions for mcpc
 * Re-exports MCP SDK types and defines additional application-specific types
 */

// Re-export core MCP types from the official SDK
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
} from '@modelcontextprotocol/sdk/types.js';

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
  timeout?: number; // Timeout in milliseconds
}

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
  createdAt: string;
  updatedAt: string;
}

/**
 * Authentication profile data stored in auth-profiles.json
 */
export interface AuthProfile {
  name: string;
  serverUrl: string;
  authType: 'oauth' | 'bearer' | 'none';
  // OAuth-specific fields
  oauthIssuer?: string;
  scopes?: string[];
  authenticatedAt?: string;
  expiresAt?: string;
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
 * Parsed command-line arguments
 */
export interface ParsedArgs {
  command?: string;
  subcommand?: string;
  args: string[];
  flags: Record<string, string | boolean>;
  // Common flags
  json?: boolean;
  verbose?: boolean;
  config?: string;
  help?: boolean;
  version?: boolean;
}

/**
 * IPC message types for CLI-bridge communication
 */
export type IpcMessageType = 'request' | 'response' | 'health-check' | 'health-ok' | 'shutdown';

/**
 * IPC message structure
 */
export interface IpcMessage {
  type: IpcMessageType;
  id?: string; // Request ID for correlation
  method?: string; // MCP method name
  params?: unknown; // Method parameters
  result?: unknown; // Response result
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
