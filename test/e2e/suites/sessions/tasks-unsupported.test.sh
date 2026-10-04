#!/bin/bash
# Test: --task/--detach and the tasks-* commands fail loudly when this connection
# cannot run tasks, instead of degrading to a plain synchronous tools/call.
#
# The flags change the shape of the output — --detach returns a task rather than a
# CallToolResult — so a silent fallback leaves callers parsing a taskId that is not
# there, with exit code 0. Each protocol era has its own way of saying "no tasks here",
# and this suite covers one per era, against a server with task support withheld:
#   modern (2026-07-28) - the server does not declare the io.modelcontextprotocol/tasks
#                         extension
#   legacy (2025-11-25) - the server does not advertise tasks.requests.tools.call

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/tasks-unsupported"

start_test_server NO_TASKS=true
if [[ "$E2E_SERVER_PROTOCOL" == "modern" ]]; then
  EXPECTED="does not declare the io.modelcontextprotocol/tasks extension"
else
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
# (On 2025-11-25 the methods are part of the core protocol whatever the server declares;
# the server's own error answers them there.)

if [[ "$E2E_SERVER_PROTOCOL" == "modern" ]]; then
  for cmd in "tasks-list" "tasks-get some-id" "tasks-result some-id" "tasks-cancel some-id"; do
    test_case "$cmd reports that the server does not declare the tasks extension"
    # shellcheck disable=SC2086
    run_mcpc "$SESSION" $cmd
    assert_failure
    assert_contains "$STDOUT$STDERR" "$EXPECTED"
    assert_contains "$STDOUT$STDERR" "mcpc $SESSION"
    test_pass
  done

  test_case "the refusal is not double-wrapped or double-punctuated"
  run_mcpc "$SESSION" tasks-list
  assert_failure
  # "Failed to list tasks: This server ... supports.. For details" would be the bad shape
  assert_not_contains "$STDOUT$STDERR" "Failed to list tasks"
  assert_not_contains "$STDOUT$STDERR" "supports.."
  test_pass

  test_case "session overview does not offer the task commands"
  run_mcpc "$SESSION"
  assert_success
  assert_not_contains "$STDOUT" "tasks-list"
  assert_not_contains "$STDOUT" "tasks (extension)"
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
