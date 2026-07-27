#!/bin/bash
# Test: --task/--detach and the tasks-* commands fail loudly when this connection
# cannot run tasks, instead of degrading to a plain synchronous tools/call.
#
# The flags change the shape of the output — --detach returns { taskId, status } rather
# than a CallToolResult — so a silent fallback leaves callers parsing a taskId that is
# not there, with exit code 0. There are two independent reasons to refuse, and this
# suite covers one per protocol era:
#   modern (2026-07-28) - tasks moved to the io.modelcontextprotocol/tasks extension
#   legacy (2025-11-25) - the server does not advertise tasks.requests.tools.call

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/tasks-unsupported"

if [[ "$E2E_SERVER_PROTOCOL" == "modern" ]]; then
  # Modern server: tasks do not exist in the protocol at all.
  start_test_server
  EXPECTED="Tasks are not available on this connection"
else
  # Legacy server with the tasks capability withheld.
  start_test_server NO_TASKS=true
  EXPECTED="does not support task-augmented tool calls"
fi

SESSION=$(session_name "notasks")

test_case "create session"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

# ── tools-call --task / --detach must refuse, not run the tool ──

test_case "tools-call --task refuses instead of running the tool synchronously"
run_mcpc "$SESSION" tools-call --task slow-task ms:=50 steps:=2
assert_failure
assert_contains "$STDOUT$STDERR" "$EXPECTED"
assert_not_contains "$STDOUT" "Completed 2 steps"
test_pass

test_case "tools-call --detach refuses instead of returning a tool result"
run_mcpc --json "$SESSION" tools-call --detach slow-task ms:=50 steps:=2
assert_failure
assert_contains "$STDERR" "$EXPECTED"
# The killer symptom: a script reading .taskId used to get a CallToolResult + exit 0
assert_not_contains "$STDOUT" "Completed"
test_pass

test_case "the refusal is a clean JSON error in --json mode"
run_mcpc --json "$SESSION" tools-call --detach slow-task ms:=50 steps:=2
assert_failure
# stdout stays machine-readable; the reason goes to stderr with an exit code
assert_json_valid "$STDERR"
assert_json_eq "$STDERR" '.code' '2'
test_pass

# ── Era-specific: the tasks-* commands on a modern connection ──

if [[ "$E2E_SERVER_PROTOCOL" == "modern" ]]; then
  for cmd in "tasks-list" "tasks-get some-id" "tasks-result some-id" "tasks-cancel some-id"; do
    test_case "$cmd reports the tasks extension is unsupported"
    # shellcheck disable=SC2086
    run_mcpc "$SESSION" $cmd
    assert_failure
    assert_contains "$STDOUT$STDERR" "Tasks are not available on this connection"
    assert_contains "$STDOUT$STDERR" "io.modelcontextprotocol/tasks extension"
    test_pass
  done

  test_case "the era-gate message is not double-wrapped or double-punctuated"
  run_mcpc "$SESSION" tasks-list
  assert_failure
  # "Failed to list tasks: Tasks are not ... 2025-11-25.. For details" was the old shape
  assert_not_contains "$STDOUT$STDERR" "Failed to list tasks"
  assert_not_contains "$STDOUT$STDERR" "2025-11-25.."
  test_pass
fi

# ── Plain tool calls still work on the same session ────────────

test_case "a plain tools-call is unaffected"
run_xmcpc "$SESSION" tools-call slow-task ms:=50 steps:=2
assert_success
assert_contains "$STDOUT" "Completed 2 steps"
test_pass

test_case "close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
