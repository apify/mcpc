#!/bin/bash
# Test: Session restart command
# Tests that mcpc @session restart properly restarts the bridge

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/restart"

# Start test server
start_test_server

# Generate unique session name for this test
SESSION=$(session_name "restart")

# =============================================================================
# Setup: Create session
# =============================================================================

test_case "setup: create session"
run_mcpc "$TEST_SERVER_URL" session "$SESSION"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

test_case "session is working"
run_mcpc "$SESSION" ping
assert_success
test_pass

# Get initial bridge PID
test_case "get initial bridge PID"
run_mcpc --json
assert_success
INITIAL_PID=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$SESSION\") | .pid")
assert_not_empty "$INITIAL_PID"
test_pass

# =============================================================================
# Test: Restart command
# =============================================================================

test_case "restart session"
run_mcpc "$SESSION" restart
assert_success
assert_contains "$STDOUT" "restarted"
test_pass

test_case "session works after restart"
run_mcpc "$SESSION" ping
assert_success
test_pass

test_case "bridge PID changed after restart"
run_mcpc --json
assert_success
NEW_PID=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$SESSION\") | .pid")
assert_not_empty "$NEW_PID"
if [[ "$INITIAL_PID" == "$NEW_PID" ]]; then
  test_fail "Bridge PID did not change after restart (still $INITIAL_PID)"
  exit 1
fi
test_pass

# =============================================================================
# Test: Restart shows server details
# =============================================================================

test_case "restart shows server capabilities"
run_mcpc "$SESSION" restart
assert_success
assert_contains "$STDOUT" "Capabilities:"
test_pass

test_case "restart shows available commands"
run_mcpc "$SESSION" restart
assert_success
assert_contains "$STDOUT" "Available commands:"
test_pass

# =============================================================================
# Test: Restart with JSON output
# =============================================================================

test_case "restart --json returns valid JSON"
run_mcpc --json "$SESSION" restart
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '._meta.server.url'
assert_json "$STDOUT" '.capabilities'
test_pass

# =============================================================================
# Test: Restart non-existent session
# =============================================================================

test_case "restart non-existent session fails"
run_xmcpc "@nonexistent-session" restart
assert_failure
assert_contains "$STDERR" "Session not found"
test_pass

# =============================================================================
# Cleanup
# =============================================================================

test_case "cleanup: close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
