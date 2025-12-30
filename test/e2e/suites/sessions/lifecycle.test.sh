#!/bin/bash
# Test: Session lifecycle (connect, use, close)

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/lifecycle"

# Start test server
start_test_server

# Generate unique session name for this test
SESSION=$(session_name "lifecycle")

# Test: connect creates session
test_case "connect creates session"
run_mcpc "$TEST_SERVER_URL" session "$SESSION"
assert_success "connect should succeed"
assert_contains "$STDOUT" "created"
_SESSIONS_CREATED+=("$SESSION")
test_pass

# Test: session appears in list
test_case "session appears in list"
run_mcpc --json
assert_success
assert_json "$STDOUT" ".sessions[] | select(.name == \"$SESSION\")"
test_pass

# Test: session status is live
test_case "session status is live"
run_mcpc --json
session_status=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .bridgeStatus")
assert_eq "$session_status" "live" "session should be live"
test_pass

# Test: can list tools via session
test_case "tools-list works via session"
run_mcpc "$SESSION" tools-list
assert_success
assert_contains "$STDOUT" "echo"
test_pass

# Test: can call tool via session
test_case "tools-call works via session"
run_mcpc "$SESSION" tools-call echo --args message="hello world"
assert_success
assert_contains "$STDOUT" "hello world"
test_pass

# Test: close session
test_case "close removes session"
run_mcpc "$SESSION" close
assert_success
assert_contains "$STDOUT" "closed"
test_pass

# Test: session no longer in list
test_case "session removed from list after close"
run_mcpc --json
if echo "$STDOUT" | jq -e ".sessions[] | select(.name == \"$SESSION\")" >/dev/null 2>&1; then
  test_fail "session should not exist after close"
  exit 1
fi
test_pass

# Test: using closed session fails
test_case "using closed session fails"
run_mcpc "$SESSION" tools-list
assert_failure
test_pass

# Remove from cleanup list since we already closed it
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")

test_done
