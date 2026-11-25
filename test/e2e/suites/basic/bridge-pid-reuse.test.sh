#!/bin/bash
# Test: a bridge PID recycled by the OS is never signalled
#
# sessions.json remembers each bridge by PID. After a reboot that number belongs to
# whatever the OS started next, and a command on the session used to SIGTERM/SIGKILL
# that unrelated process while "restarting" the bridge. Here an unrelated `sleep` plays
# the stranger: its PID is written into the session record in place of the dead bridge's,
# and it must survive both a command on the session (which restarts the bridge) and `close`.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/bridge-pid-reuse"

if is_windows; then
  skip_suite "bash child PIDs are MSYS PIDs on Windows, not the Windows PIDs mcpc checks"
fi

start_test_server

SESSION=$(session_name "pidreuse")

# Crash the session's bridge (SIGKILL: a graceful exit would end the server-side MCP
# session, which a crash or reboot leaves alive) and record the stranger's PID instead.
replace_bridge_with_stranger() {
  local pid
  pid=$(jq -r --arg name "$SESSION" '.sessions[$name].pid // empty' "$MCPC_HOME_DIR/sessions.json")
  assert_not_empty "$pid" "session should have a bridge PID"
  kill -9 "$pid" 2>/dev/null || true
  if ! wait_for_process_exit "$pid"; then
    test_fail "bridge $pid did not exit"
    exit 1
  fi
  edit_sessions_json --arg name "$SESSION" --argjson pid "$STRANGER" '.sessions[$name].pid = $pid'
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

test_case "a command on the session restarts the bridge and leaves the recycled PID alone"
replace_bridge_with_stranger
run_mcpc "$SESSION" ping
assert_success
assert_stranger_alive
run_mcpc --json
new_pid=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .pid")
if [[ -z "$new_pid" || "$new_pid" == "$STRANGER" ]]; then
  test_fail "session should have a new bridge PID, got '$new_pid' (stranger: $STRANGER)"
  exit 1
fi
test_pass

test_case "close leaves the recycled PID alone"
replace_bridge_with_stranger
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
assert_stranger_alive
test_pass

test_done
