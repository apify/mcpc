#!/bin/bash
# Test: Session failover (bridge crash recovery)

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/failover"

# Start test server
start_test_server

# Generate unique session name
SESSION=$(session_name "failover")

# Test: create session for failover test
test_case "create session for failover test"
run_mcpc "$TEST_SERVER_URL" session "$SESSION"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

# Test: get bridge PID
test_case "get bridge PID"
run_mcpc --json
bridge_pid=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .pid")
assert_not_empty "$bridge_pid" "should have bridge PID"
test_pass

# Test: verify session works before killing
test_case "session works before kill"
run_mcpc "$SESSION" tools-list
assert_success
test_pass

# Test: kill bridge process
test_case "kill bridge process"
kill "$bridge_pid" 2>/dev/null || true
sleep 1

# Verify it's dead
if kill -0 "$bridge_pid" 2>/dev/null; then
  test_fail "bridge should be dead"
  exit 1
fi
test_pass

# Test: session shows as dead
test_case "session shows as dead after bridge kill"
run_mcpc --json
session_status=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .bridgeStatus")
assert_eq "$session_status" "dead" "session should show as dead"
test_pass

# Test: using session triggers automatic restart
test_case "using dead session triggers restart"
run_mcpc "$SESSION" tools-list
assert_success "session should auto-restart and work"
assert_contains "$STDOUT" "echo"
test_pass

# Test: session is live again
test_case "session is live after auto-restart"
run_mcpc --json
session_status=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .bridgeStatus")
assert_eq "$session_status" "live" "session should be live again"
test_pass

# Test: new PID is different
test_case "bridge has new PID after restart"
new_pid=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .pid")
if [[ "$new_pid" == "$bridge_pid" ]]; then
  test_fail "PID should be different after restart"
  exit 1
fi
test_pass

test_done
