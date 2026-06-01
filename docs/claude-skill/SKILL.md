---
name: mcpc
description: Use mcpc CLI to interact with MCP servers - call tools, read resources, get prompts. Use this when working with Model Context Protocol servers, calling MCP tools, or accessing MCP resources programmatically.
allowed-tools: Bash(mcpc:*), Bash(node dist/cli/index.js:*), Read, Grep
---

# mcpc: MCP command-line client

Use `mcpc` to interact with MCP (Model Context Protocol) servers from the command line.
This is more efficient than function calling - generate shell commands instead.

## Quick reference

```bash
# List sessions and auth profiles
mcpc

# Show server info
mcpc @<session>

# Tools
mcpc @<session> tools-list
mcpc @<session> tools-get <tool-name>
mcpc @<session> tools-call <tool-name> key:=value key2:="string value"

# Resources
mcpc @<session> resources-list
mcpc @<session> resources-read <uri>

# Prompts
mcpc @<session> prompts-list
mcpc @<session> prompts-get <prompt-name> arg1:=value1

# Sessions (persistent connections)
mcpc connect <server> @<name>
mcpc @<name> <command>
mcpc close @<name>
mcpc restart @<name>

# Authentication
mcpc login <server>
mcpc logout <server>
```

## Target types

- `mcp.example.com` - Direct HTTPS connection to remote server
- `localhost:8080` or `127.0.0.1:8080` - Local HTTP server (http:// is default for localhost)
- `@session-name` - Named persistent session (faster, maintains state)
- `.vscode/mcp.json:filesystem` - Entry from a config file (`file:entry`)

## Passing arguments

Arguments use `key:=value` syntax. Values are auto-parsed as JSON when valid:

```bash
# String values
mcpc @s tools-call search query:="hello world"

# Numbers, booleans, null (auto-parsed as JSON)
mcpc @s tools-call search query:="hello" limit:=10 enabled:=true

# Complex JSON values
mcpc @s tools-call search config:='{"nested":"value"}' items:='[1,2,3]'

# Force string type with JSON quotes
mcpc @s tools-call search id:='"123"'

# Inline JSON object (if first arg starts with { or [)
mcpc @s tools-call search '{"query":"hello","limit":10}'

# From stdin (auto-detected when piped)
echo '{"query":"hello"}' | mcpc @s tools-call search
```

## JSON output for scripting

Always use `--json` flag for machine-readable output:

```bash
# Get tools as JSON
mcpc --json @apify tools-list

# Call tool and parse result with jq
mcpc --json @apify tools-call search query:="test" | jq '.content[0].text'

# Chain commands
mcpc --json @server1 tools-call get-data | mcpc @server2 tools-call process
```

## Sessions for efficiency

Create sessions for repeated interactions:

```bash
# Create session (or reconnect if exists)
mcpc connect mcp.apify.com @apify

# Use session (faster - no reconnection overhead)
mcpc @apify tools-list
mcpc @apify tools-call search query:="test"

# Restart session (useful after server updates)
mcpc restart @apify

# Close when done
mcpc close @apify
```

**Session states:**
- 🟢 **live** - Bridge running, server might or might not be responding
- 🟡 **crashed** - Bridge crashed; auto-restarts on next use
- 🔴 **expired** - Server rejected session; needs `close` and reconnect

## Authentication

**OAuth (interactive login)**:
```bash
mcpc login mcp.apify.com
mcpc connect mcp.apify.com @apify
```

**Bearer token**:
```bash
mcpc connect mcp.apify.com @myserver -H "Authorization: Bearer $TOKEN"
mcpc --json @myserver tools-list
```

## Proxy server for AI isolation

Create a proxy MCP server that hides authentication tokens:

```bash
# Human creates authenticated session with proxy
mcpc connect mcp.apify.com @ai-proxy --proxy 8080

# AI agent connects to proxy (no access to original tokens)
# Note: localhost defaults to http://
mcpc connect localhost:8080 @sandboxed
mcpc @sandboxed tools-list
```

## Common patterns

**List and inspect tools**:
```bash
mcpc @s tools-list
mcpc @s tools-get tool-name
```

**Call tool and extract text result**:
```bash
mcpc --json @s tools-call my-tool | jq -r '.content[0].text'
```

**Read resource content**:
```bash
mcpc @s resources-read "file:///path/to/file"
```

**Use config file for local servers**:
```bash
mcpc connect .vscode/mcp.json:filesystem @filesystem
mcpc @filesystem resources-list
```

## Exit codes

- `0` - Success
- `1` - Client error (invalid arguments)
- `2` - Server error (tool failed)
- `3` - Network error
- `4` - Authentication error

## Debugging

```bash
# Verbose output shows protocol details
mcpc --verbose @s tools-call my-tool
```

## Example script

See [`docs/examples/company-lookup.sh`](../examples/company-lookup.sh) for a complete example
of an AI-generated script that validates prerequisites and calls MCP tools.
