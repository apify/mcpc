#!/bin/bash
# Test: session management commands (close, restart)

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/session-commands"

start_test_server

# =============================================================================
# mcpc close @session  (top-level form)
# =============================================================================

test_case "mcpc close @session closes the session"
SESSION=$(session_name "close")
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
run_mcpc close "$SESSION"
assert_success
# Session should no longer exist
run_mcpc --json
assert_success
session_exists=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$SESSION\") | .name")
assert_empty "$session_exists" "session should not exist after close"
test_pass

test_case "mcpc close missing @session errors"
run_mcpc close
assert_failure
test_pass

# =============================================================================
# mcpc restart @session  (top-level form)
# =============================================================================

test_case "mcpc restart @session restarts the session"
SESSION=$(session_name "restart")
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
# Get initial PID
run_mcpc --json
INITIAL_PID=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$SESSION\") | .pid")
assert_not_empty "$INITIAL_PID"
# Restart
run_mcpc restart "$SESSION"
assert_success
assert_contains "$STDOUT" "restarted"
# Bridge PID should change
run_mcpc --json
NEW_PID=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$SESSION\") | .pid")
assert_not_empty "$NEW_PID"
if [[ "$INITIAL_PID" == "$NEW_PID" ]]; then
  test_fail "Bridge PID did not change after restart (still $INITIAL_PID)"
  exit 1
fi
test_pass

test_case "mcpc restart missing @session errors"
run_mcpc restart
assert_failure
test_pass

test_done
