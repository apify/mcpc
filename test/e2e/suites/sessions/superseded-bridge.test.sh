#!/bin/bash
# Test: a superseded bridge exits on its own (#427)
#
# The CLI replaces a bridge whenever it believes the old one is dead. When that belief
# is wrong (a timed-out `tasklist` on Windows reported every PID dead) or two CLI
# processes restart the same session in parallel, nothing ever tells the old bridge to
# exit: nothing references its PID anymore and its own keepalive pings keep succeeding.
# The bridge now checks on every keepalive tick that sessions.json still names it, and
# bows out when another PID has taken over — without ending the server-side MCP session
# the replacement may have resumed.
#
# Manipulates sessions.json directly, so it needs an isolated home.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/superseded-bridge" --isolated

start_test_server

SESSION=$(session_name "superseded")

test_case "setup: create session"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

test_case "setup: bridge is registered and working"
run_mcpc "$SESSION" ping
assert_success
run_mcpc --json
assert_success
BRIDGE_PID=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .pid")
assert_not_empty "$BRIDGE_PID" "session should record its bridge PID"
MCP_SESSION_ID=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .mcpSessionId // empty")
test_pass

test_case "bridge exits once another PID is registered for its session"
# Point the record at another bridge that does not exist, as a parallel restart or a CLI
# misled by a failing liveness check would. No mcpc command runs until the bridge is gone:
# the CLI would notice the dead PID, mark the session crashed and start a real replacement.
OTHER_PID=$(( BRIDGE_PID + 100000 ))
edit_sessions_json --arg name "$SESSION" --argjson pid "$OTHER_PID" '.sessions[$name].pid = $pid'
# The bridge's first keepalive tick fires 5s after it connected and later ones every 30s;
# the takeover is confirmed on a second read one second later.
if ! wait_for_process_exit "$BRIDGE_PID" 60; then
  test_fail "bridge $BRIDGE_PID still running 60s after another PID was registered"
  exit 1
fi
test_pass

test_case "superseded bridge says why it exited"
LOG_FILE="$MCPC_HOME_DIR/logs/bridge-${SESSION}.log"
assert_file_exists "$LOG_FILE"
assert_contains "$(cat "$LOG_FILE")" "Another bridge (PID $OTHER_PID) is registered for this session"
test_pass

test_case "superseded bridge leaves the server-side MCP session alone"
if [[ -n "$MCP_SESSION_ID" ]]; then
  deleted_sessions=$(curl -s "$TEST_SERVER_URL/control/get-deleted-sessions" | jq -r '.deletedSessions[]')
  assert_not_contains "$deleted_sessions" "$MCP_SESSION_ID" \
    "the replacement bridge may have resumed this MCP session, so it must not be terminated"
  active_sessions=$(curl -s "$TEST_SERVER_URL/control/get-active-sessions" | jq -r '.activeSessions[]')
  assert_contains "$active_sessions" "$MCP_SESSION_ID" "the MCP session should still be active on the server"
  test_pass
else
  # 2026-07-28 servers assign no session ID, so there is nothing to terminate
  test_skip "server assigns no MCP session ID"
fi

test_case "cleanup: close the session record"
# The record names a PID that never existed; drop it so close has nothing to stop.
edit_sessions_json --arg name "$SESSION" 'del(.sessions[$name].pid)'
run_mcpc "$SESSION" close
assert_success
test_pass

test_done
