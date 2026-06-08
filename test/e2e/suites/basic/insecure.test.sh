#!/bin/bash
# Test: --insecure flag for self-signed TLS certificates

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/insecure" --isolated

# Start plain HTTP test server, then wrap it with self-signed HTTPS
start_test_server
start_https_test_server

# Test: MCP operations fail when connecting to self-signed HTTPS without --insecure
# Note: `connect` itself succeeds (bridge spawns async), but actual MCP commands fail
# because the bridge can't complete the TLS handshake with the self-signed cert.
test_case "tools-list fails without --insecure on self-signed cert"
SESSION_FAIL=$(session_name "no-insecure")
run_mcpc connect "$TEST_HTTPS_SERVER_URL" "$SESSION_FAIL" --header "X-Test: true"
assert_success  # connect just spawns bridge, always succeeds
_SESSIONS_CREATED+=("$SESSION_FAIL")
# Give the bridge a moment to attempt connection and fail
sleep 2
run_mcpc "$SESSION_FAIL" tools-list
assert_failure
test_pass

# --insecure relies on undici's TLS-bypass dispatcher, which Bun's fetch ignores.
# Since the bridge runs under the same runtime as the CLI, the behaviour differs:
# under Node the flag works; under Bun mcpc rejects it loudly (rather than silently
# failing to skip verification).
RUNTIME="${E2E_RUNTIME:-node}"

if [ "$RUNTIME" = "bun" ]; then
  # Test: --insecure is rejected with a clear error under Bun
  test_case "bun: connect --insecure fails with a clear error"
  SESSION=$(session_name "insecure-bun")
  _SESSIONS_CREATED+=("$SESSION") # register for cleanup in case connect left a record
  run_mcpc connect "$TEST_HTTPS_SERVER_URL" "$SESSION" --header "X-Test: true" --insecure
  assert_failure
  assert_contains "$STDERR" "not supported under the Bun runtime"
  test_pass
else
  # Test: connection with --insecure flag succeeds (Node)
  test_case "connect with --insecure succeeds and tools-list works"
  SESSION=$(session_name "insecure-flag")
  run_mcpc connect "$TEST_HTTPS_SERVER_URL" "$SESSION" --header "X-Test: true" --insecure
  assert_success
  _SESSIONS_CREATED+=("$SESSION")
  test_pass

  # Test: MCP operations work through insecure session
  test_case "tools-list works over insecure session"
  run_xmcpc "$SESSION" tools-list
  assert_success
  assert_contains "$STDOUT" "echo"
  test_pass

  # Test: tool call works
  test_case "tools-call works over insecure session"
  run_mcpc "$SESSION" tools-call echo message:=hello
  assert_success
  assert_contains "$STDOUT" "hello"
  test_pass
fi

test_done
