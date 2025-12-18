# Quick Testing Guide for mcpc

This guide provides quick commands to test the current implementation of mcpc.

## Prerequisites

```bash
npm install
npm run build
```

## Quick Tests

### 1. Help and Version

```bash
# Show help
node dist/cli/index.js --help

# Show version
node dist/cli/index.js --version
```

### 2. HTTP URL Targets

```bash
# Try to connect to a URL (will fail - no real server)
node dist/cli/index.js https://example.com/mcp tools-list

# With verbose logging
node dist/cli/index.js https://example.com/mcp --verbose tools-list
```

### 3. Config File Loading

```bash
# List servers in config
cat examples/test-config.json

# Use HTTP server from config (will fail to connect)
node dist/cli/index.js --config examples/test-config.json example-http tools-list

# Try non-existent server (shows error)
node dist/cli/index.js --config examples/test-config.json bad-server tools-list

# Test environment variable substitution
EXAMPLE_API_TOKEN=secret123 node dist/cli/index.js \
  --config examples/test-config.json example-http tools-list
```

### 4. Package Resolution

```bash
# Create test package in node_modules
mkdir -p node_modules/example-mcp-server
cp -r examples/test-package/* node_modules/example-mcp-server/

# Try to use the package (will fail - not a real MCP server)
node dist/cli/index.js example-mcp-server tools-list

# Try non-existent package (shows helpful error)
node dist/cli/index.js nonexistent-package tools-list

# With verbose to see resolution details
node dist/cli/index.js example-mcp-server --verbose tools-list
```

### 5. Named Sessions (Not Implemented)

```bash
# Try named session (shows "not implemented")
node dist/cli/index.js @my-session tools-list
```

## Real MCP Server Testing

To test with an actual MCP server, you can:

### Option 1: Install an official MCP server package

```bash
# Install a real MCP server (example - adjust as needed)
npm install -g @modelcontextprotocol/server-filesystem

# Use it with mcpc
mcpc @modelcontextprotocol/server-filesystem tools-list
```

### Option 2: Use a remote MCP server

```bash
# If you have access to a real MCP server URL
mcpc https://your-mcp-server.com tools-list
mcpc https://your-mcp-server.com resources-list
```

### Option 3: Create a config file for your servers

```json
{
  "mcpServers": {
    "my-server": {
      "url": "https://my-real-mcp-server.com",
      "headers": {
        "Authorization": "Bearer ${MY_API_KEY}"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
```

Then use it:
```bash
MY_API_KEY=secret mcpc --config my-config.json my-server tools-list
mcpc --config my-config.json filesystem resources-list
```

## Unit Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- test/lib/config.test.ts
npm test -- test/lib/package-resolver.test.ts

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

## Linting

```bash
# Check for issues
npm run lint

# Auto-fix issues
npm run lint:fix
```

## Expected Behaviors

### ✅ Should Work

- CLI help and version display
- HTTP URL parsing and resolution
- Config file loading and parsing
- Environment variable substitution in configs
- Package discovery in node_modules
- Global package discovery (npm and Bun)
- Clear error messages for missing files/packages
- Verbose logging with --verbose flag

### ❌ Will Fail (Expected)

These will fail because they require actual MCP servers:

- Connecting to example.com (not an MCP server)
- Using the test package (doesn't implement MCP protocol)
- Any command that needs actual MCP communication

These will fail because they're not implemented yet:

- Named sessions (@session-name)
- Session commands (connect, close)
- Interactive shell

## Troubleshooting

### "Package not found" error
- Make sure the package is installed in node_modules or globally
- Check the package name spelling
- Verify package.json exists in the package

### "Config file not found" error
- Check the path to the config file
- Use absolute path or path relative to current directory

### "Server not found in config" error
- Check the server name matches exactly (case-sensitive)
- List available servers in the error message

### "Failed to connect" error
- This is expected when testing with non-real MCP servers
- Use a real MCP server URL or package to test actual connections

## What's Next

After confirming tests work, you can proceed with:

**Phase 2: Bridge & Sessions**
- Persistent MCP connections
- Session management
- Unix socket IPC

**Phase 3: Authentication**
- OAuth 2.1 support
- Keychain integration
- Auth profile management

**Phase 4: Enhancements**
- Interactive shell
- Caching
- Tab completion
