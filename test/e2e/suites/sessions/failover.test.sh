#!/bin/bash
# Test: Session failover (bridge crash recovery)

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/failover"

# This suite asserts the 2025-era expired-session flow: after a bridge crash the
# server rejects the stale MCP session ID and the session must be explicitly
# restarted. Stateless 2026-07-28 connections have no session ID to reject
# (crash recovery there is covered by sessions/bridge-resilience).
require_server_protocol legacy

# Start test server
start_test_server

# Generate unique session name
SESSION=$(session_name "failover")

# Test: create session for failover test
test_case "create session for failover test"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

# Test: get bridge PID
test_case "get bridge PID"
# Use run_mcpc (not run_xmcpc) because session list can change between
# the 4 variant calls when other tests run in parallel with shared home
run_mcpc --json
bridge_pid=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .pid")
assert_not_empty "$bridge_pid" "should have bridge PID"
test_pass

# Test: verify session works before killing
test_case "session works before kill"
run_xmcpc "$SESSION" tools-list
assert_success
test_pass

# Test: kill bridge process
test_case "kill bridge process"
_kill_tree "$bridge_pid"

# Verify it's no longer running. The SIGTERM shutdown is graceful (session
# DELETE + client close, each with its own timeout budget), so poll rather than
# using a fixed sleep — on slow machines 1s is not enough (flaky).
if ! wait_for_process_exit "$bridge_pid"; then
  test_fail "bridge should not be running"
  exit 1
fi
if is_windows; then
  # On Windows, force-kill doesn't allow graceful shutdown (no HTTP DELETE),
  # so the server still has the session active. Expire it via control API
  # to simulate the session being invalidated.
  curl -s -X POST "$TEST_SERVER_URL/control/expire-session" >/dev/null
fi
test_pass

# Test: session shows as crashed or reconnecting
test_case "session shows as crashed or reconnecting after bridge kill"
# Poll rather than assert once: the status is derived from the bridge process
# being gone, and the OS does not necessarily reap it the instant the kill
# returns (slower on Windows and under parallel load).
# Session may show as "crashed" (bridge dead) or "reconnecting" (auto-reconnect in progress)
session_status=""
for _ in $(seq 1 15); do
  run_mcpc --json
  session_status=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .status")
  if [[ "$session_status" == "crashed" || "$session_status" == "reconnecting" ]]; then
    break
  fi
  sleep 0.3
done
if [[ "$session_status" != "crashed" && "$session_status" != "reconnecting" ]]; then
  test_fail "session should show as crashed or reconnecting, got: $session_status"
  exit 1
fi
test_pass

# Test: using crashed session attempts restart but server rejects old session ID
# This is correct behavior - session should be marked as expired, not auto-reconnected
test_case "using crashed session fails when server rejects session ID"
run_xmcpc "$SESSION" tools-list
# This should FAIL because server rejects the old session ID
# and session is marked as expired (not auto-reconnected)
if [[ "$EXIT_CODE" -eq 0 ]]; then
  test_fail "expected command to fail when server rejects session ID"
  exit 1
fi
test_pass

# Test: session is marked as expired (not live)
test_case "session marked as expired after rejection"
run_mcpc --json
session_status=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .status")
assert_eq "$session_status" "expired" "session should be marked as expired"
test_pass

# Test: explicit restart recovers from expired session
test_case "explicit restart recovers from expired session"
# Reset server state so the restarted bridge can connect
if is_windows; then
  curl -s -X POST "$TEST_SERVER_URL/control/reset" >/dev/null
fi
run_mcpc "$SESSION" restart
assert_success
test_pass

# Test: session is live again after explicit restart
test_case "session is live after explicit restart"
run_mcpc --json
session_status=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .status")
assert_eq "$session_status" "live" "session should be live after restart"
test_pass

# Test: commands work after explicit restart
test_case "commands work after explicit restart"
run_xmcpc "$SESSION" tools-list
assert_success "commands should work after explicit restart"
assert_contains "$STDOUT" "echo"
test_pass

# Test: new PID is different
test_case "bridge has new PID after restart"
run_mcpc --json
new_pid=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .pid")
if [[ "$new_pid" == "$bridge_pid" ]]; then
  test_fail "PID should be different after restart"
  exit 1
fi
test_pass

test_done
