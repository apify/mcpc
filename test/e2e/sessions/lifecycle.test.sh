#!/bin/bash
# Test: Session lifecycle (connect, use, close)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"

setup_test
trap cleanup_test EXIT

# Test 1: Connect to test server
begin_test "connect creates session"
run_mcpc "$TEST_SERVER_URL" session "$TEST_SESSION"
assert_success $EXIT_CODE "connect should succeed"
assert_contains "$STDOUT" "created"
pass

# Test 2: Session appears in list
begin_test "session appears in list"
run_mcpc_json
assert_success $EXIT_CODE
assert_json "$STDOUT" ".sessions[] | select(.name == \"$TEST_SESSION\")"
pass

# Test 3: Session status is live
begin_test "session status is live"
run_mcpc_json
session_status=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$TEST_SESSION\") | .bridgeStatus")
assert_eq "$session_status" "live" "session should be live"
pass

# Test 4: Can list tools via session
begin_test "tools-list works via session"
run_mcpc "$TEST_SESSION" tools-list
assert_success $EXIT_CODE
assert_contains "$STDOUT" "echo"
pass

# Test 5: Can call tool via session
begin_test "tools-call works via session"
run_mcpc "$TEST_SESSION" tools-call echo --args message="hello world"
assert_success $EXIT_CODE
assert_contains "$STDOUT" "hello world"
pass

# Test 6: Close session
begin_test "close removes session"
run_mcpc "$TEST_SESSION" close
assert_success $EXIT_CODE
assert_contains "$STDOUT" "closed"
pass

# Test 7: Session no longer in list
begin_test "session removed from list after close"
run_mcpc_json
# Session should not exist
if echo "$STDOUT" | jq -e ".sessions[] | select(.name == \"$TEST_SESSION\")" >/dev/null 2>&1; then
  fail "session should not exist after close"
fi
pass

# Test 8: Using closed session fails
begin_test "using closed session fails"
run_mcpc "$TEST_SESSION" tools-list
assert_failure $EXIT_CODE
pass

print_summary
