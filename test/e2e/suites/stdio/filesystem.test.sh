#!/bin/bash
# Test: Stdio transport with filesystem MCP server

source "$(dirname "$0")/../../lib/framework.sh"
test_init "stdio/filesystem"

# Create a config file for the filesystem server
CONFIG=$(create_fs_config "$TEST_TMP")

# Generate unique session name
SESSION=$(session_name "fs")

# Test: create session with stdio config
test_case "create session with stdio config"
run_mcpc --config "$CONFIG" fs session "$SESSION"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

# Test: session shows stdio transport
test_case "session shows stdio transport"
run_mcpc_json
transport=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .transport")
assert_eq "$transport" "stdio" "transport should be stdio"
test_pass

# Test: list tools via stdio session
test_case "tools-list works via stdio session"
run_mcpc "$SESSION" tools-list
assert_success
assert_contains "$STDOUT" "read_file"
test_pass

# Test: create test file
test_case "create test file"
echo "Hello from E2E test!" > "$TEST_TMP/test.txt"
test_pass

# Test: read file via MCP
test_case "read file via MCP"
run_mcpc "$SESSION" tools-call read_file --args path="$TEST_TMP/test.txt"
assert_success
assert_contains "$STDOUT" "Hello from E2E test"
test_pass

# Test: list directory via MCP
test_case "list directory via MCP"
run_mcpc "$SESSION" tools-call list_directory --args path="$TEST_TMP"
assert_success
assert_contains "$STDOUT" "test.txt"
test_pass

# Test: write file via MCP
test_case "write file via MCP"
run_mcpc "$SESSION" tools-call write_file --args path="$TEST_TMP/written.txt" content="Written via MCP"
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
