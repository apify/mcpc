#!/bin/bash
# Test: Stdio transport with filesystem MCP server

source "$(dirname "$0")/../../lib/framework.sh"
test_init "stdio/filesystem"

# Create a config file for the filesystem server
CONFIG=$(create_fs_config "$TEST_TMP")

# =============================================================================
# Test: Session-based commands
# =============================================================================

# Generate unique session name
SESSION=$(session_name "fs")

# Test: create session with stdio config
test_case "create session with stdio config"
run_mcpc connect "$CONFIG:fs" "$SESSION"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

# Test: session shows stdio transport (has command field, no url field)
# Note: Use run_mcpc because session list is non-deterministic in parallel tests
# (timestamps change, other tests create sessions). Invariant tested separately.
test_case "session shows stdio transport"
run_mcpc --json
command=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .serverConfig.command")
assert_not_empty "$command" "command should be present for stdio transport"
test_pass

# Test: negotiated protocol version is detected for stdio sessions.
# Regression guard: MCP SDK v1's stdio client transport never exposed the
# negotiated protocolVersion (typescript-sdk#1468), so mcpc <= 0.5.0 showed
# "MCP: version unknown" for every stdio server. The v2 client reports it via
# getNegotiatedProtocolVersion() regardless of transport.
test_case "protocol version is detected for stdio session"
run_mcpc "$SESSION"
assert_success
assert_contains "$STDOUT" "MCP: version 20"
assert_not_contains "$STDOUT" "MCP: version unknown"
# The same line names the transport: a stdio child process is always stateful
assert_contains "$STDOUT" "stdio (stateful)"
test_pass

# Test: --json reports the transport next to the stateless flag
test_case "transport in --json session details"
run_mcpc --json "$SESSION"
assert_success
assert_eq "$(json_get '._mcpc.transport')" "stdio" "transport should be stdio"
assert_eq "$(json_get '._mcpc.stateless')" "false" "stdio connections are stateful"
test_pass

# Test: protocol version is present in --json session details
test_case "protocol version in --json session details"
run_mcpc --json "$SESSION"
assert_success
protocol_version=$(json_get ".protocolVersion")
case "$protocol_version" in
  20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *) test_fail "protocolVersion should be a date-formatted MCP version, got: $protocol_version" ;;
esac
test_pass

# Test: list tools via stdio session
test_case "tools-list works via stdio session"
run_xmcpc "$SESSION" tools-list
assert_success
assert_contains "$STDOUT" "read_file"
test_pass

# Test: create test file
test_case "create test file"
echo "Hello from E2E test!" > "$TEST_TMP/test.txt"
test_pass

# Test: read file via MCP (read-only tool, safe for run_xmcpc)
test_case "read file via MCP"
run_xmcpc "$SESSION" tools-call read_file "path:=$NATIVE_TEST_TMP/test.txt"
assert_success
assert_contains "$STDOUT" "Hello from E2E test"
test_pass

# Test: list directory via MCP (output includes temp files with random names, use run_mcpc)
test_case "list directory via MCP"
run_mcpc "$SESSION" tools-call list_directory "path:=$NATIVE_TEST_TMP"
assert_success
assert_contains "$STDOUT" "test.txt"
test_pass

# Test: write file via MCP
test_case "write file via MCP"
run_mcpc "$SESSION" tools-call write_file "path:=$NATIVE_TEST_TMP/written.txt" "content:=Written via MCP"
assert_success
test_pass

# Test: verify written file
test_case "verify written file"
content=$(cat "$TEST_TMP/written.txt")
assert_eq "$content" "Written via MCP"
test_pass

# Test: close session
test_case "close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
