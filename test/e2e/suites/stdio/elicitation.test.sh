#!/bin/bash
# Test form elicitation decisions through the CLI and stdio bridge.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "stdio/elicitation"

SERVER="$(to_native_path "$PROJECT_ROOT/test/e2e/server/elicitation-stdio-server.mjs")"
CONFIG=$(create_stdio_config "elicitation" "node" "$SERVER")
SESSION=$(session_name "elicitation")

test_case "create stdio session with elicitation server"
run_mcpc connect "$CONFIG:elicitation" "$SESSION"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

test_case "accepted form input is forwarded and JSON stays on stdout"
set +e
E2E_ELICITATION_CHOICE=accept python3 "$PROJECT_ROOT/test/e2e/lib/run-pty.py" \
  node "$PROJECT_ROOT/dist/cli/index.js" --json "$SESSION" tools-call request_input --elicitation \
  >"$TEST_TMP/accept.stdout" 2>"$TEST_TMP/accept.stderr"
EXIT_CODE=$?
set -e
STDOUT=$(cat "$TEST_TMP/accept.stdout")
STDERR=$(cat "$TEST_TMP/accept.stderr")
assert_exit_code 0
assert_json_valid "$STDOUT"
assert_eq "$(json_get '.content[0].text | fromjson | .action')" "accept"
assert_eq "$(json_get '.content[0].text | fromjson | .content.name')" "Ada"
assert_contains "$STDERR" "Provide your display name"
test_pass

test_case "declining a form is returned as JSON"
set +e
E2E_ELICITATION_CHOICE=decline python3 "$PROJECT_ROOT/test/e2e/lib/run-pty.py" \
  node "$PROJECT_ROOT/dist/cli/index.js" --json "$SESSION" tools-call request_input --elicitation \
  >"$TEST_TMP/decline.stdout" 2>"$TEST_TMP/decline.stderr"
EXIT_CODE=$?
set -e
STDOUT=$(cat "$TEST_TMP/decline.stdout")
STDERR=$(cat "$TEST_TMP/decline.stderr")
assert_exit_code 0
assert_json_valid "$STDOUT"
assert_eq "$(json_get '.content[0].text | fromjson | .action')" "decline"
test_pass

test_case "non-interactive calls cancel form requests by default"
run_mcpc --json "$SESSION" tools-call request_input
assert_success
assert_json_valid "$STDOUT"
assert_eq "$(json_get '.content[0].text | fromjson | .action')" "cancel"
test_pass

test_case "overlapping requests cannot share one approval"
set +e
E2E_ELICITATION_CHOICE=accept python3 "$PROJECT_ROOT/test/e2e/lib/run-pty.py" \
  node "$PROJECT_ROOT/dist/cli/index.js" --json "$SESSION" tools-call request_input overlap:=true --elicitation \
  >"$TEST_TMP/overlap.stdout" 2>"$TEST_TMP/overlap.stderr"
EXIT_CODE=$?
set -e
STDOUT=$(cat "$TEST_TMP/overlap.stdout")
assert_exit_code 0
assert_eq "$(json_get '.content[0].text | fromjson | map(.action) | sort | join(",")')" "accept,cancel"
test_pass

test_case "notifications during approval refresh tools and subscribed files"
run_mcpc "$SESSION" resources-subscribe test://resource "$TEST_TMP/resource.txt"
assert_success
set +e
E2E_ELICITATION_CHOICE=decline python3 "$PROJECT_ROOT/test/e2e/lib/run-pty.py" \
  node "$PROJECT_ROOT/dist/cli/index.js" --json "$SESSION" tools-call request_input notify:=true --elicitation \
  >"$TEST_TMP/notify.stdout" 2>"$TEST_TMP/notify.stderr"
EXIT_CODE=$?
set -e
assert_exit_code 0
for attempt in {1..30}; do
  [ "$(cat "$TEST_TMP/resource.txt")" = "updated" ] && break
  sleep 0.1
done
assert_eq "$(cat "$TEST_TMP/resource.txt")" "updated"
run_mcpc --json "$SESSION" tools-list
assert_success
assert_contains "$STDOUT" "new_tool"
test_pass

test_case "restoring subscriptions blocks interactive calls until complete"
run_mcpc "$SESSION" restart
assert_success
set +e
E2E_ELICITATION_CHOICE=accept python3 "$PROJECT_ROOT/test/e2e/lib/run-pty.py" \
  node "$PROJECT_ROOT/dist/cli/index.js" --json "$SESSION" tools-call request_input --elicitation \
  >"$TEST_TMP/restore.stdout" 2>"$TEST_TMP/restore.stderr"
EXIT_CODE=$?
set -e
assert_exit_code 1
STDERR=$(cat "$TEST_TMP/restore.stderr")
assert_contains "$STDERR" "interactive tool calls require exclusive access"
test_pass

test_case "timed-out prompt closes and later forms fail closed"
TIMEOUT_SESSION=$(session_name "elicitation-timeout")
export NODE_OPTIONS="--require=$PROJECT_ROOT/test/e2e/server/short-elicitation-timeout.cjs"
run_mcpc connect "$CONFIG:elicitation" "$TIMEOUT_SESSION"
unset NODE_OPTIONS
assert_success
_SESSIONS_CREATED+=("$TIMEOUT_SESSION")
set +e
E2E_ELICITATION_CHOICE=none python3 "$PROJECT_ROOT/test/e2e/lib/run-pty.py" \
  node "$PROJECT_ROOT/dist/cli/index.js" --json "$TIMEOUT_SESSION" tools-call request_input timeoutSecond:=true --elicitation \
  >"$TEST_TMP/timeout.stdout" 2>"$TEST_TMP/timeout.stderr"
EXIT_CODE=$?
set -e
STDOUT=$(cat "$TEST_TMP/timeout.stdout")
assert_exit_code 0
assert_eq "$(json_get '.content[0].text | fromjson | map(.action) | join(",")')" "cancel,cancel"
test_pass

test_case "late elicitation responses cannot reject the parent tool call"
set +e
node "$PROJECT_ROOT/test/e2e/lib/late-elicitation-response.mjs" "$TIMEOUT_SESSION" \
  >"$TEST_TMP/late.stdout" 2>"$TEST_TMP/late.stderr"
EXIT_CODE=$?
set -e
STDERR=$(cat "$TEST_TMP/late.stderr")
[ "$EXIT_CODE" -eq 0 ] || echo "# $STDERR"
assert_exit_code 0
test_pass

test_case "invalid elicitation responses cancel without rejecting the tool call"
set +e
node "$PROJECT_ROOT/test/e2e/lib/late-elicitation-response.mjs" "$TIMEOUT_SESSION" invalid \
  >"$TEST_TMP/invalid.stdout" 2>"$TEST_TMP/invalid.stderr"
EXIT_CODE=$?
set -e
STDERR=$(cat "$TEST_TMP/invalid.stderr")
[ "$EXIT_CODE" -eq 0 ] || echo "# $STDERR"
assert_exit_code 0
test_pass

test_done
