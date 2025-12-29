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
mcpc <server>
mcpc @<session>

# Tools
mcpc <target> tools-list
mcpc <target> tools-schema <tool-name>
mcpc <target> tools-call <tool-name> --args '{"key":"value"}'

# Resources
mcpc <target> resources-list
mcpc <target> resources-read <uri>

# Prompts
mcpc <target> prompts-list
mcpc <target> prompts-get <prompt-name> --args key=value

# Sessions (persistent connections)
mcpc <server> session @<name>
mcpc @<name> <command>
mcpc @<name> close

# Authentication
mcpc <server> login
mcpc <server> logout
```

## Target types

- `mcp.example.com` - Direct HTTP connection to remote server
- `@session-name` - Named persistent session (faster, maintains state)
- `config-entry` - Entry from config file (with `--config`)

## Passing arguments

**Inline JSON** (recommended for complex data):
```bash
mcpc @s tools-call search --args '{"query":"hello","limit":10}'
```

**Key=value pairs** (strings):
```bash
mcpc @s tools-call search --args query="hello world" filter=active
```

**Key:=json pairs** (typed values):
```bash
mcpc @s tools-call search --args query="hello" limit:=10 enabled:=true
```

**From file**:
```bash
mcpc @s tools-call search --args-file params.json
```

**From stdin** (auto-detected when piped):
```bash
echo '{"query":"hello"}' | mcpc @s tools-call search
```

## JSON output for scripting

Always use `--json` flag for machine-readable output:

```bash
# Get tools as JSON
mcpc --json @apify tools-list

# Call tool and parse result with jq
mcpc --json @apify tools-call search --args query="test" | jq '.content[0].text'

# Chain commands
mcpc --json @server1 tools-call get-data | mcpc @server2 tools-call process
```

## Sessions for efficiency

Create sessions for repeated interactions:

```bash
# Create session (or reconnect if exists)
mcpc mcp.apify.com session @apify

# Use session (faster - no reconnection overhead)
mcpc @apify tools-list
mcpc @apify tools-call search --args query="test"

# Close when done
mcpc @apify close
```

## Authentication

**OAuth (interactive login)**:
```bash
mcpc mcp.apify.com login
mcpc mcp.apify.com session @apify
```

**Bearer token**:
```bash
mcpc -H "Authorization: Bearer $TOKEN" mcp.apify.com tools-list
mcpc -H "Authorization: Bearer $TOKEN" mcp.apify.com session @myserver
```

## Common patterns

**List and inspect tools**:
```bash
mcpc @s tools-list
mcpc @s tools-schema tool-name
```

**Call tool and extract text result**:
```bash
mcpc --json @s tools-call my-tool --args '{}' | jq -r '.content[0].text'
```

**Read resource content**:
```bash
mcpc @s resources-read "file:///path/to/file"
```

**Use config file for local servers**:
```bash
mcpc --config .vscode/mcp.json filesystem resources-list
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
mcpc --verbose @s tools-call my-tool --args '{}'
```
