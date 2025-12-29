#!/bin/bash
# Test: Session failover (bridge crash recovery)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"

setup_test
trap cleanup_test EXIT

# Test 1: Create a session
begin_test "create session for failover test"
run_mcpc "$TEST_SERVER_URL" session "$TEST_SESSION"
assert_success $EXIT_CODE
pass

# Test 2: Get the bridge PID
begin_test "get bridge PID"
run_mcpc_json
bridge_pid=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$TEST_SESSION\") | .pid")
assert_not_empty "$bridge_pid" "should have bridge PID"
pass

# Test 3: Verify session works before killing
begin_test "session works before kill"
run_mcpc "$TEST_SESSION" tools-list
assert_success $EXIT_CODE
pass

# Test 4: Kill the bridge process
begin_test "kill bridge process"
kill "$bridge_pid" 2>/dev/null || true
sleep 1

# Verify it's dead
if kill -0 "$bridge_pid" 2>/dev/null; then
  fail "bridge should be dead"
fi
pass

# Test 5: Session shows as dead
begin_test "session shows as dead after bridge kill"
run_mcpc_json
session_status=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$TEST_SESSION\") | .bridgeStatus")
assert_eq "$session_status" "dead" "session should show as dead"
pass

# Test 6: Using session triggers automatic restart
begin_test "using dead session triggers restart"
run_mcpc "$TEST_SESSION" tools-list
assert_success $EXIT_CODE "session should auto-restart and work"
assert_contains "$STDOUT" "echo"
pass

# Test 7: Session is live again
begin_test "session is live after auto-restart"
run_mcpc_json
session_status=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$TEST_SESSION\") | .bridgeStatus")
assert_eq "$session_status" "live" "session should be live again"
pass

# Test 8: New PID is different
begin_test "bridge has new PID after restart"
new_pid=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$TEST_SESSION\") | .pid")
if [[ "$new_pid" == "$bridge_pid" ]]; then
  fail "PID should be different after restart"
fi
pass

print_summary
