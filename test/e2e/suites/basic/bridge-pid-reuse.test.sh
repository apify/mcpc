#!/bin/bash
# Test: a bridge PID recycled by the OS is never signalled
#
# sessions.json remembers each bridge by PID. After a reboot that number belongs to
# whatever the OS started next, and a command on the session used to SIGTERM/SIGKILL
# that unrelated process while "restarting" the bridge. Here an unrelated `sleep`
# plays the stranger: its PID is written into the session record in place of the dead
# bridge's, and it must survive a command on the session, the session listing, and
# `close` — each of which must carry on as if the bridge had simply crashed.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/bridge-pid-reuse"

if is_windows; then
  skip_suite "bash child PIDs are MSYS PIDs on Windows, not the Windows PIDs mcpc checks"
fi

start_test_server

SESSION=$(session_name "pidreuse")
SESSIONS_FILE="$MCPC_HOME_DIR/sessions.json"

# The recorded bridge PID, read straight from sessions.json: `mcpc --json` would
# consolidate the record (and reconnect the session) as a side effect.
recorded_pid() {
  jq -r --arg name "$SESSION" '.sessions[$name].pid // empty' "$SESSIONS_FILE"
}

# Crash the session's current bridge and wait until it is gone. SIGKILL, not SIGTERM: a
# SIGTERMed bridge shuts down gracefully and ends the server-side MCP session, which the
# replacement would then fail to resume — a crash (or a reboot) leaves it alive.
kill_bridge() {
  local pid
  pid=$(recorded_pid)
  assert_not_empty "$pid" "session should have a bridge PID"
  kill -9 "$pid" 2>/dev/null || true
  if ! wait_for_process_exit "$pid"; then
    test_fail "bridge $pid did not exit"
    exit 1
  fi
}

# Register the stranger's PID as the session's bridge, as a reboot would leave it.
register_stranger() {
  edit_sessions_json --arg name "$SESSION" --argjson pid "$STRANGER" \
    '.sessions[$name].pid = $pid | .sessions[$name].status = "active" | .sessions[$name].lastSeenAt = (now | todate)'
}

assert_stranger_alive() {
  if ! process_is_running "$STRANGER"; then
    test_fail "the unrelated process $STRANGER was killed"
    exit 1
  fi
}

test_case "create session"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

# The unrelated process that must not be touched. Its stdio is detached so the runner's
# capture of this script's output does not wait for it, and the EXIT trap removes it.
sleep 300 >/dev/null 2>&1 </dev/null &
STRANGER=$!
_previous_exit_trap=$(trap -p EXIT | sed "s/trap -- '\(.*\)' EXIT/\1/")
trap 'kill "$STRANGER" 2>/dev/null || true; '"$_previous_exit_trap" EXIT

test_case "a command on the session leaves the recycled PID alone and restarts the bridge"
kill_bridge
register_stranger
run_mcpc "$SESSION" ping
assert_success
assert_contains "$STDOUT" "Ping successful"
assert_stranger_alive
new_pid=$(recorded_pid)
assert_not_empty "$new_pid" "session should have a new bridge PID"
if [[ "$new_pid" == "$STRANGER" ]]; then
  test_fail "the recycled PID $STRANGER is still recorded as the bridge"
  exit 1
fi
test_pass

test_case "the session list treats the recycled PID as a crashed bridge"
kill_bridge
register_stranger
run_mcpc --json
assert_success
assert_stranger_alive
listed_pid=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .pid // empty")
if [[ "$listed_pid" == "$STRANGER" ]]; then
  test_fail "the session list still reports the recycled PID $STRANGER as the bridge"
  exit 1
fi
listed_status=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .status")
assert_eq "$listed_status" "crashed" "a recycled PID should read as a crashed bridge"
# The next command reconnects the session (the listing's own background reconnect is
# rate-limited and may not have run); the stranger must survive that too.
run_mcpc "$SESSION" ping
assert_success
assert_stranger_alive
test_pass

test_case "close leaves the recycled PID alone"
kill_bridge
register_stranger
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
assert_stranger_alive
run_mcpc --json
session_exists=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .name")
assert_empty "$session_exists" "session should not exist after close"
test_pass

test_done
