#!/bin/bash
# Test: A session name stays bound to the server it was created for
#
# A session carries state that belongs to its server (stored headers, --insecure, --x402,
# the server's session id, resource subscriptions that write local files). `connect` used to
# merge a new target into an existing non-live session, handing all of that to the new
# server, and bulk connects take the session name from a config entry.
#
# Covered scenarios:
#  1. `connect <other server> @existing` is refused while the session is live
#  2. ...and while its bridge is down, leaving the record untouched
#  3. A config entry named after an existing session (bulk connect) is refused the same way
#  4. Reconnecting the same server writes this command's settings: --insecure and stored
#     headers from the earlier connect are dropped, not kept
#  5. A session can be re-created for another server once it is closed

source "$(dirname "$0")/../../lib/framework.sh"
# Isolated home: any `mcpc` listing reconnects crashed sessions in the background, so in a
# shared home another suite could revive this one's killed bridge mid-test.
test_init "sessions/connect-name-reuse" --isolated

start_test_server

SESSION=$(session_name "reuse")
# Never contacted: the name conflict is detected before any connection is made.
OTHER_URL="http://127.0.0.1:9/other-server"

# Read a field of the session record straight from sessions.json. Listing sessions with
# `mcpc --json` would do, but a listing also reconnects crashed sessions in the background,
# which would race the connects this suite is about.
session_field() {
  jq -r --arg s "$SESSION" ".sessions[\$s] | $1" "$MCPC_HOME_DIR/sessions.json"
}

kill_bridge() {
  local pid
  pid=$(session_field ".pid")
  assert_not_empty "$pid" "session should have a bridge PID"
  _kill_tree "$pid"
  if ! wait_for_process_exit "$pid"; then
    test_fail "bridge process should have been killed"
    exit 1
  fi
}

assert_session_unchanged() {
  assert_eq "$(session_field ".server.url")" "$TEST_SERVER_URL" "session should still point at its server"
  assert_eq "$(session_field ".insecure")" "true" "session should keep its --insecure setting"
  assert_eq "$(session_field ".server.headers[\"X-Test\"]")" "<redacted>" "session should keep its header"
}

# =============================================================================
test_case "connecting another server under a live session's name is refused"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true" --insecure
assert_success
_SESSIONS_CREATED+=("$SESSION")

run_mcpc connect "$OTHER_URL" "$SESSION"
assert_failure
assert_contains "$STDERR" "already exists for a different server"
assert_contains "$STDERR" "mcpc $SESSION close"
assert_session_unchanged
test_pass

# =============================================================================
test_case "...and is refused while the session's bridge is down"
kill_bridge
run_mcpc connect "$OTHER_URL" "$SESSION"
assert_failure
assert_contains "$STDERR" "already exists for a different server"
assert_session_unchanged
test_pass

# =============================================================================
test_case "a config entry named after the session cannot take it over"
ENTRY_NAME="${SESSION#@}"
CONFIG_FILE="$TEST_TMP/takeover.json"
cat > "$CONFIG_FILE" <<EOF
{ "mcpServers": { "$ENTRY_NAME": { "url": "$OTHER_URL" } } }
EOF
run_mcpc connect "$(to_native_path "$CONFIG_FILE")"
assert_failure
run_mcpc connect "$(to_native_path "$CONFIG_FILE")" --json
assert_failure
assert_json_valid "$STDOUT"
assert_eq "$(json_get '.[0]._mcpc.status')" "failed" "the entry should be reported as failed"
assert_contains "$(json_get '.[0]._mcpc.error')" "already exists for a different server"
assert_session_unchanged
test_pass

# =============================================================================
test_case "reconnecting the same server applies this command's settings, not the old ones"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION"
assert_success
assert_eq "$(session_field ".server.url")" "$TEST_SERVER_URL" "session should point at the same server"
assert_eq "$(session_field ".insecure // \"unset\"")" "unset" "--insecure should not carry over"
assert_eq "$(session_field ".server.headers // \"unset\"")" "unset" "headers should not carry over"
run_mcpc "$SESSION" tools-list
assert_success
test_pass

# =============================================================================
test_case "a live session of the same server is reported as already active"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION"
assert_success
assert_contains "$STDOUT" "already active"
test_pass

# =============================================================================
test_case "the name can be used for another server once the session is closed"
run_mcpc "$SESSION" close
assert_success
run_mcpc connect "$TEST_SERVER_URL/" "$SESSION" --header "X-Test: true"
assert_success
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
