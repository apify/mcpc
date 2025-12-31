#!/bin/bash
# Test: JSON output schema consistency with MCP specification
# Ensures --json output matches the MCP protocol specification
# Reference: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/json-schema"

# Start test server
start_test_server

# Generate unique session name for this test
SESSION=$(session_name "json-schema")

# Create session for testing
test_case "setup: create session"
run_mcpc "$TEST_SERVER_URL" session "$SESSION"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

# =============================================================================
# Test: mcpc @session --json (server details / handshake result)
# MCP spec: InitializeResult contains protocolVersion, capabilities, serverInfo
# =============================================================================

test_case "server details JSON has protocolVersion"
run_mcpc "$SESSION" --json
assert_success
assert_json_valid "$STDOUT"
# protocolVersion is required per MCP spec
assert_json "$STDOUT" '.protocolVersion' "should have protocolVersion field"
test_pass

test_case "server details JSON has capabilities object"
run_mcpc "$SESSION" --json
assert_success
# capabilities is required per MCP spec
assert_json "$STDOUT" '.capabilities' "should have capabilities field"
test_pass

test_case "server details JSON has serverInfo object"
run_mcpc "$SESSION" --json
assert_success
# serverInfo is required per MCP spec
assert_json "$STDOUT" '.serverInfo' "should have serverInfo field"
assert_json "$STDOUT" '.serverInfo.name' "serverInfo should have name"
assert_json "$STDOUT" '.serverInfo.version' "serverInfo should have version"
test_pass

test_case "server details JSON serverInfo matches test server"
run_mcpc "$SESSION" --json
assert_success
server_name=$(json_get '.serverInfo.name')
assert_eq "$server_name" "e2e-test-server" "server name should be e2e-test-server"
test_pass

# TODO: change this to check: if instructions field is present, it is a string!
test_case "server details JSON has instructions field"
run_mcpc "$SESSION" --json
assert_success
# instructions is optional per MCP spec but if present, must be named correctly
# This test catches typos like "instructionsX"
assert_json "$STDOUT" '.instructions' "should have instructions field (check for typos)"
test_pass

test_case "server details JSON has exact expected fields"
run_mcpc "$SESSION" --json
assert_success
# MCP InitializeResult - validate exact top-level fields (no more, no less)
expected_fields="_meta,capabilities,instructions,protocolVersion,serverInfo"
actual_fields=$(echo "$STDOUT" | jq -r 'keys | sort | join(",")')
if [[ "$actual_fields" != "$expected_fields" ]]; then
  test_fail "unexpected top-level fields: expected [$expected_fields], got [$actual_fields]"
fi
# _meta.server.url must be present
assert_json "$STDOUT" '._meta.server.url' "_meta.server should have url field"
# Verify url contains localhost (our test server)
server_url=$(json_get '._meta.server.url')
if [[ "$server_url" != *"localhost"* ]]; then
  test_fail "_meta.server.url should contain localhost, got: $server_url"
fi
test_pass

# =============================================================================
# Test: tools-list --json
# MCP spec: ListToolsResult contains tools array
# =============================================================================

test_case "tools-list JSON is valid array"
run_mcpc "$SESSION" tools-list --json
assert_success
assert_json_valid "$STDOUT"
# Result should be an array of tools
assert_json "$STDOUT" '.[0]' "should be a non-empty array"
test_pass

test_case "tools-list JSON tool has required fields"
run_mcpc "$SESSION" tools-list --json
assert_success
# Per MCP spec, Tool must have: name, inputSchema
assert_json "$STDOUT" '.[0].name' "tool should have name"
assert_json "$STDOUT" '.[0].inputSchema' "tool should have inputSchema"
test_pass

test_case "tools-list JSON tool inputSchema has type"
run_mcpc "$SESSION" tools-list --json
assert_success
# inputSchema must be a valid JSON Schema object
assert_json "$STDOUT" '.[0].inputSchema.type' "inputSchema should have type"
input_type=$(json_get '.[0].inputSchema.type')
assert_eq "$input_type" "object" "inputSchema type should be 'object'"
test_pass

test_case "tools-list JSON tool has optional description"
run_mcpc "$SESSION" tools-list --json
assert_success
# description is optional but test server provides it
assert_json "$STDOUT" '.[0].description' "tool should have description"
test_pass

# =============================================================================
# Test: tools-get --json
# Should return the same tool structure as tools-list
# =============================================================================

test_case "tools-get JSON matches tool structure"
run_mcpc "$SESSION" tools-get echo --json
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '.name' "should have name"
assert_json "$STDOUT" '.inputSchema' "should have inputSchema"
tool_name=$(json_get '.name')
assert_eq "$tool_name" "echo" "tool name should be 'echo'"
test_pass

# =============================================================================
# Test: resources-list --json
# MCP spec: ListResourcesResult contains resources array
# =============================================================================

test_case "resources-list JSON is valid array"
run_mcpc "$SESSION" resources-list --json
assert_success
assert_json_valid "$STDOUT"
# Result should be an array of resources
assert_json "$STDOUT" '.[0]' "should be a non-empty array"
test_pass

test_case "resources-list JSON resource has required uri"
run_mcpc "$SESSION" resources-list --json
assert_success
# Per MCP spec, Resource must have: uri
assert_json "$STDOUT" '.[0].uri' "resource should have uri"
test_pass

test_case "resources-list JSON resource has optional fields"
run_mcpc "$SESSION" resources-list --json
assert_success
# Test server provides these optional fields
assert_json "$STDOUT" '.[0].name' "resource should have name"
assert_json "$STDOUT" '.[0].mimeType' "resource should have mimeType"
test_pass

# =============================================================================
# Test: resources-templates-list --json
# MCP spec: ListResourceTemplatesResult contains resourceTemplates array
# =============================================================================

test_case "resources-templates-list JSON is valid array"
run_mcpc "$SESSION" resources-templates-list --json
assert_success
assert_json_valid "$STDOUT"
# Result should be an array
assert_json "$STDOUT" '.[0]' "should be a non-empty array"
test_pass

test_case "resources-templates-list JSON template has uriTemplate"
run_mcpc "$SESSION" resources-templates-list --json
assert_success
# Per MCP spec, ResourceTemplate must have: uriTemplate
assert_json "$STDOUT" '.[0].uriTemplate' "template should have uriTemplate"
test_pass

# =============================================================================
# Test: prompts-list --json
# MCP spec: ListPromptsResult contains prompts array
# =============================================================================

test_case "prompts-list JSON is valid array"
run_mcpc "$SESSION" prompts-list --json
assert_success
assert_json_valid "$STDOUT"
# Result should be an array of prompts
assert_json "$STDOUT" '.[0]' "should be a non-empty array"
test_pass

test_case "prompts-list JSON prompt has required name"
run_mcpc "$SESSION" prompts-list --json
assert_success
# Per MCP spec, Prompt must have: name
assert_json "$STDOUT" '.[0].name' "prompt should have name"
test_pass

test_case "prompts-list JSON prompt arguments have required fields"
run_mcpc "$SESSION" prompts-list --json
assert_success
# Per MCP spec, PromptArgument must have: name, required (boolean)
assert_json "$STDOUT" '.[0].arguments[0].name' "argument should have name"
# required field should be boolean
arg_required=$(json_get '.[0].arguments[0].required')
if [[ "$arg_required" != "true" && "$arg_required" != "false" ]]; then
  test_fail "argument.required should be boolean, got: $arg_required"
fi
test_pass

# =============================================================================
# Test: prompts-get --json
# MCP spec: GetPromptResult contains messages array
# =============================================================================

test_case "prompts-get JSON has messages array"
run_mcpc "$SESSION" prompts-get greeting --args name=Test --json
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '.messages' "should have messages array"
assert_json "$STDOUT" '.messages[0]' "messages should not be empty"
test_pass

test_case "prompts-get JSON message has role and content"
run_mcpc "$SESSION" prompts-get greeting --args name=Test --json
assert_success
# Per MCP spec, PromptMessage must have: role, content
assert_json "$STDOUT" '.messages[0].role' "message should have role"
assert_json "$STDOUT" '.messages[0].content' "message should have content"
test_pass

# =============================================================================
# Test: tools-call --json
# MCP spec: CallToolResult contains content array
# =============================================================================

test_case "tools-call JSON has content array"
run_mcpc "$SESSION" tools-call echo --args message="test" --json
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '.content' "should have content array"
assert_json "$STDOUT" '.content[0]' "content should not be empty"
test_pass

test_case "tools-call JSON content item has type"
run_mcpc "$SESSION" tools-call echo --args message="test" --json
assert_success
# Per MCP spec, content items must have type
assert_json "$STDOUT" '.content[0].type' "content item should have type"
content_type=$(json_get '.content[0].type')
assert_eq "$content_type" "text" "echo tool should return text content"
test_pass

# =============================================================================
# Test: resources-read --json
# MCP spec: ReadResourceResult contains contents array
# =============================================================================

test_case "resources-read JSON has contents array"
run_mcpc "$SESSION" resources-read "test://static/hello" --json
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '.contents' "should have contents array"
assert_json "$STDOUT" '.contents[0]' "contents should not be empty"
test_pass

test_case "resources-read JSON content has uri"
run_mcpc "$SESSION" resources-read "test://static/hello" --json
assert_success
# Per MCP spec, ResourceContents must have: uri
assert_json "$STDOUT" '.contents[0].uri' "content should have uri"
test_pass

# Cleanup
test_case "cleanup: close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
