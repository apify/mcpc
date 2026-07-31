#!/bin/bash
# Test: Async task execution and detached mode

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/async-tasks"

# Tasks are a 2025-11-25 experimental feature; 2026-07-28 moved them to the
# io.modelcontextprotocol/tasks extension, which the SDK does not support yet.
require_server_protocol legacy

# Start test server
start_test_server

# Generate unique session name
SESSION=$(session_name "async")

# Create session
test_case "create session"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

# ── Task execution ───────────────────────────────────────────

test_case "tools-call --task runs with task progress"
run_mcpc "$SESSION" tools-call --task slow-task ms:=500 steps:=2
assert_success
assert_contains "$STDOUT" "Completed 2 steps in 500ms"
test_pass

test_case "tools-call --task --json returns result"
run_mcpc --json "$SESSION" tools-call --task slow-task ms:=500 steps:=2
assert_success
assert_json_valid "$STDOUT"
assert_contains "$STDOUT" "Completed 2 steps in 500ms"
test_pass

# ── Detached execution ───────────────────────────────────────

test_case "tools-call --detach returns task ID"
run_mcpc "$SESSION" tools-call --detach slow-task ms:=2000 steps:=3
assert_success
assert_contains "$STDOUT" "Task started:"
test_pass

test_case "tools-call --detach --json returns taskId and status"
run_mcpc --json "$SESSION" tools-call --detach slow-task ms:=2000 steps:=3
assert_success
assert_json_valid "$STDOUT"
TASK_ID=$(echo "$STDOUT" | jq -r '.taskId')
assert_not_empty "$TASK_ID" "taskId should be present"
assert_json_eq "$STDOUT" '.status' 'working'
test_pass

# ── Task management (using TASK_ID from previous detach) ─────

test_case "tasks-list shows active tasks"
run_mcpc "$SESSION" tasks-list
assert_success
assert_contains "$STDOUT" "$TASK_ID"
test_pass

test_case "tasks-list --json returns tasks array"
run_mcpc --json "$SESSION" tasks-list
assert_success
assert_json_valid "$STDOUT"
task_count=$(echo "$STDOUT" | jq '.tasks | length')
assert_not_empty "$task_count"
# At least the task we just started (may include the earlier one too)
test_pass

test_case "tasks-get shows task status"
run_mcpc "$SESSION" tasks-get "$TASK_ID"
assert_success
assert_contains "$STDOUT" "$TASK_ID"
test_pass

test_case "tasks-get --json returns task details"
run_mcpc --json "$SESSION" tasks-get "$TASK_ID"
assert_success
assert_json_valid "$STDOUT"
assert_json_eq "$STDOUT" '.taskId' "$TASK_ID"
test_pass

# ── Task cancellation ────────────────────────────────────────

test_case "tasks-cancel cancels a running task"
# Start a long-running task
run_mcpc --json "$SESSION" tools-call --detach slow-task ms:=10000 steps:=5
assert_success
CANCEL_TASK_ID=$(echo "$STDOUT" | jq -r '.taskId')
assert_not_empty "$CANCEL_TASK_ID" "should get task ID for cancellation"
# Cancel it
run_mcpc "$SESSION" tasks-cancel "$CANCEL_TASK_ID"
assert_success
assert_contains "$STDOUT" "cancelled"
test_pass

test_case "tasks-cancel --json returns cancelled status"
# Start another long-running task
run_mcpc --json "$SESSION" tools-call --detach slow-task ms:=10000 steps:=5
assert_success
CANCEL_TASK_ID2=$(echo "$STDOUT" | jq -r '.taskId')
# Cancel it
run_mcpc --json "$SESSION" tasks-cancel "$CANCEL_TASK_ID2"
assert_success
assert_json_valid "$STDOUT"
assert_json_eq "$STDOUT" '.status' 'cancelled'
test_pass

# ── Wait for detached task to complete, then verify ──────────

test_case "detached task completes and result is available"
run_mcpc --json "$SESSION" tools-call --detach slow-task ms:=500 steps:=2
assert_success
WAIT_TASK_ID=$(echo "$STDOUT" | jq -r '.taskId')
# Wait for task to complete
sleep 1
run_mcpc --json "$SESSION" tasks-get "$WAIT_TASK_ID"
assert_success
assert_json_eq "$STDOUT" '.status' 'completed'
assert_contains "$STDOUT" "Done (2 steps)"
test_pass

# ── tasks-result (fetch final CallToolResult payload) ────────

test_case "tasks-result returns the CallToolResult payload"
run_mcpc "$SESSION" tasks-result "$WAIT_TASK_ID"
assert_success
assert_contains "$STDOUT" "Completed 2 steps in 500ms"
test_pass

test_case "tasks-result --json returns the raw CallToolResult"
run_mcpc --json "$SESSION" tasks-result "$WAIT_TASK_ID"
assert_success
assert_json_valid "$STDOUT"
assert_contains "$STDOUT" "Completed 2 steps in 500ms"
# The payload is a CallToolResult, so it must contain a content[] array
content_type=$(echo "$STDOUT" | jq -r '.content[0].type')
assert_eq "$content_type" "text"
test_pass

test_case "tasks-result blocks until the task reaches a terminal state"
# Start a task that takes ~1.5 seconds and immediately ask for its result
run_mcpc --json "$SESSION" tools-call --detach slow-task ms:=1500 steps:=3
assert_success
RESULT_TASK_ID=$(echo "$STDOUT" | jq -r '.taskId')
# This should block on the server until the task completes, then return the payload
run_mcpc --json "$SESSION" tasks-result "$RESULT_TASK_ID"
assert_success
assert_json_valid "$STDOUT"
assert_contains "$STDOUT" "Completed 3 steps in 1500ms"
test_pass

# ── Synchronous fallback (no --task) ─────────────────────────

test_case "tools-call without --task runs synchronously"
run_xmcpc "$SESSION" tools-call slow-task ms:=200 steps:=1
assert_success
assert_contains "$STDOUT" "Completed 1 steps in 200ms"
test_pass

test_done
