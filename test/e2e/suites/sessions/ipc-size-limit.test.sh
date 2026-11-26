#!/bin/bash
# Test: a response or request over the 10 MB IPC limit is an ordinary error
#
# The CLI used to drop the bridge connection when a response outgrew its buffer, then
# treat that as a bridge crash: stop the healthy bridge, end the server session, start
# a new one and fetch the same oversized result again. Any server could trigger it with
# one large tool result or resource. The bridge must survive and the error must say why.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/ipc-size-limit"

start_test_server

SESSION=$(session_name "ipcsize")

bridge_pid() {
  jq -r --arg name "$SESSION" '.sessions[$name].pid // empty' "$MCPC_HOME_DIR/sessions.json"
}

test_case "create session"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION"
assert_success
_SESSIONS_CREATED+=("$SESSION")
PID_BEFORE=$(bridge_pid)
assert_not_empty "$PID_BEFORE" "session should have a bridge PID"
test_pass

test_case "a response under the limit is delivered"
run_mcpc --json "$SESSION" resources-read test://large/2mb
assert_success
assert_json "$STDOUT" '.contents[0].text | length == 2097152'
test_pass

test_case "an oversized response fails with a server error that names the limit"
run_mcpc "$SESSION" resources-read test://large/11mb
assert_exit_code 2
assert_contains "$STDERR" "too large"
assert_contains "$STDERR" "limit 10.0 MB"
test_pass

test_case "an oversized response keeps the { error, code } shape in JSON mode"
run_mcpc --json "$SESSION" resources-read test://large/11mb
assert_exit_code 2
assert_stdout_empty
assert_json "$STDERR" '.code == 2 and (.error | contains("too large"))'
test_pass

test_case "an oversized request is refused before it is sent"
head -c 11000000 /dev/zero | tr '\0' 'x' | jq -Rc '{message: .}' >"$TEST_TMP/big-args.json"
run_mcpc "$SESSION" tools-call echo <"$TEST_TMP/big-args.json"
assert_exit_code 1
assert_contains "$STDERR" "Request is too large"
assert_not_contains "$STDERR" "may or may not have executed"
test_pass

test_case "the bridge was not restarted and the session still works"
assert_eq "$(bridge_pid)" "$PID_BEFORE" "bridge PID should be unchanged"
run_mcpc --json "$SESSION"
assert_success
assert_json "$STDOUT" '.serverInfo.name != null'
run_mcpc "$SESSION" ping
assert_success
test_pass

test_done
