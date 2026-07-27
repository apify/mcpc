#!/bin/bash
# Test: task commands fail loudly on 2026-07-28 servers instead of degrading silently
#
# Regression guard: tasks moved to the io.modelcontextprotocol/tasks extension in
# 2026-07-28 and mcpc does not support it yet. Every task command must say so. The
# dangerous case is `tools-call --detach`, which used to fall through to a plain
# tools/call — running the tool synchronously and handing scripts a tool result
# where they parse a taskId, with exit code 0.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/tasks-unsupported"

require_server_protocol modern

# Start test server
start_test_server

SESSION=$(session_name "notasks")

test_case "create session on a 2026-07-28 server"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
assert_contains "$STDOUT" "Protocol: 2026-07-28"
test_pass

# ── Task commands report the missing extension ────────────────

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

# ── tools-call --task / --detach must not silently run the tool ────

test_case "tools-call --task refuses instead of running the tool synchronously"
run_mcpc "$SESSION" tools-call --task slow-task ms:=50 steps:=2
assert_failure
assert_contains "$STDOUT$STDERR" "Tasks are not available on this connection"
assert_not_contains "$STDOUT" "Completed 2 steps"
test_pass

test_case "tools-call --detach refuses instead of returning a tool result"
run_mcpc --json "$SESSION" tools-call --detach slow-task ms:=50 steps:=2
assert_failure
assert_contains "$STDERR" "Tasks are not available on this connection"
# The killer symptom: a script reading .taskId used to get a CallToolResult + exit 0
assert_not_contains "$STDOUT" "Completed"
test_pass

# ── Plain tool calls still work on the same session ────────────

test_case "a plain tools-call is unaffected"
run_mcpc "$SESSION" tools-call slow-task ms:=50 steps:=2
assert_success
assert_contains "$STDOUT" "Completed 2 steps"
test_pass

test_case "close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
