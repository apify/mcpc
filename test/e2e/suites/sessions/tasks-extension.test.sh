#!/bin/bash
# Test: the io.modelcontextprotocol/tasks extension (MCP 2026-07-28).
#
# sessions/async-tasks pins down the command surface that both protocol eras share. This
# suite covers what only the extension does — and what mcpc has to do about it:
#   - task creation is the server's call: a plain tools-call may come back as a task
#     (mcpc waits for it), and a --detach call may come back with the result instead
#   - the Task shape (ttlMs, pollIntervalMs, the result inlined in tasks/get)
#   - the Mcp-Name routing header on every tasks/* request
#   - a task that waits for input, which mcpc cannot answer
#   - tasks-list showing the tasks this session created (the extension has no listing)
#   - the session overview reporting the server's declaration

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/tasks-extension"
require_server_protocol modern

start_test_server

SESSION=$(session_name "tasksext")

# Server control: the Mcp-Name routing headers of the latest tasks/* requests (JSON)
server_get_task_routing() {
  curl -s "$TEST_SERVER_URL/control/get-task-routing"
}

# Poll tasks-get until the task reports the given status (or give up after ~10s)
wait_for_task_status() {
  local task_id="$1" expected="$2"
  for _ in $(seq 1 50); do
    run_mcpc --json "$SESSION" tasks-get "$task_id"
    if [[ $EXIT_CODE -eq 0 && "$(echo "$STDOUT" | jq -r .status)" == "$expected" ]]; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

test_case "setup: connect to a server declaring the tasks extension"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

# ── Discovery ────────────────────────────────────────────────

test_case "session overview lists the tasks extension and offers the task commands"
run_mcpc "$SESSION"
assert_success
assert_contains "$STDOUT" "tasks (extension)"
assert_contains "$STDOUT" "mcpc $SESSION tasks-list"
assert_contains "$STDOUT" "mcpc $SESSION tasks-result <taskId>"
test_pass

test_case "--json reports the server's declaration verbatim"
run_mcpc --json "$SESSION"
assert_success
assert_json_eq "$STDOUT" '.capabilities.extensions["io.modelcontextprotocol/tasks"] | tojson' "{}"
test_pass

# ── Server-directed task creation ────────────────────────────

test_case "a plain tools-call that the server turns into a task is waited for"
# slow-task always comes back as a task on this server; the caller asked for a result
run_xmcpc "$SESSION" tools-call slow-task ms:=300 steps:=3
assert_success
assert_contains "$STDOUT" "Completed 3 steps in 300ms"
test_pass

test_case "--detach prints the created Task in the extension's shape"
run_mcpc --json "$SESSION" tools-call --detach slow-task ms:=1500 steps:=3
assert_success
assert_json_valid "$STDOUT"
TASK_ID=$(json_get '.taskId')
assert_not_empty "$TASK_ID" "taskId should be present"
assert_json_eq "$STDOUT" '.status' 'working'
assert_json_eq "$STDOUT" '.ttlMs' '300000'
assert_json_eq "$STDOUT" '.pollIntervalMs' '200'
# The wire discriminator is the SDK's business, not the caller's
assert_json "$STDOUT" 'has("resultType") | not'
assert_json "$STDOUT" 'has("createdAt") and has("lastUpdatedAt")'
test_pass

test_case "--detach on a call the server answers synchronously prints the tool result"
run_mcpc "$SESSION" tools-call --detach echo message:=hi
assert_success
assert_contains "$STDOUT" "ran the tool synchronously instead of creating a task"
assert_contains "$STDOUT" "hi"
run_mcpc --json "$SESSION" tools-call --detach echo message:=hi
assert_success
assert_json_valid "$STDOUT"
# A CallToolResult, not a task: scripts tell the two apart by taskId
assert_json_eq "$STDOUT" '.content[0].text' 'hi'
assert_json "$STDOUT" 'has("taskId") | not'
test_pass

# ── Polling and the inlined result ───────────────────────────

test_case "tasks-get shows the task's TTL and poll interval"
run_mcpc "$SESSION" tasks-get "$TASK_ID"
assert_success
assert_contains "$STDOUT" "TTL: 5 min"
assert_contains "$STDOUT" "Poll interval: 200 ms"
test_pass

test_case "tasks-result polls tasks/get until the task completes and prints the inlined result"
run_mcpc --json "$SESSION" tasks-result "$TASK_ID"
assert_success
assert_json_valid "$STDOUT"
assert_json_eq "$STDOUT" '.content[0].text' 'Completed 3 steps in 1500ms'
test_pass

test_case "tasks-get on a completed task carries the result (--json) and points at it (human)"
run_mcpc --json "$SESSION" tasks-get "$TASK_ID"
assert_success
assert_json_eq "$STDOUT" '.status' 'completed'
assert_json_eq "$STDOUT" '.result.content[0].text' 'Completed 3 steps in 1500ms'
run_mcpc "$SESSION" tasks-get "$TASK_ID"
assert_success
assert_contains "$STDOUT" "Result: ready"
assert_contains "$STDOUT" "tasks-result $TASK_ID"
test_pass

# ── Routing header (spec MUST over Streamable HTTP) ──────────

test_case "every tasks/* request carries Mcp-Name: <taskId>"
ROUTING=$(server_get_task_routing)
assert_json "$ROUTING" '.routing | length > 0'
assert_json "$ROUTING" '.routing | all(.mcpName == .taskId)'
assert_json "$ROUTING" '[.routing[].method] | index("tasks/get") != null'
test_pass

# ── Cooperative cancellation ─────────────────────────────────

test_case "tasks-cancel acknowledges and reports the task's state right after"
run_mcpc --json "$SESSION" tools-call --detach slow-task ms:=10000 steps:=5
assert_success
CANCEL_ID=$(json_get '.taskId')
run_mcpc --json "$SESSION" tasks-cancel "$CANCEL_ID"
assert_success
assert_json_eq "$STDOUT" '.status' 'cancelled'
ROUTING=$(server_get_task_routing)
assert_json "$ROUTING" '[.routing[] | select(.method == "tasks/cancel")] | length > 0 and all(.mcpName == .taskId)'
test_pass

test_case "tasks-result on a cancelled task fails with the outcome"
run_mcpc "$SESSION" tasks-result "$CANCEL_ID"
assert_failure
assert_exit_code 2
assert_contains "$STDERR" "was cancelled"
test_pass

# ── Unknown task ─────────────────────────────────────────────

test_case "tasks-get of an unknown task is a server error"
run_mcpc "$SESSION" tasks-get no-such-task
assert_failure
assert_exit_code 2
assert_contains "$STDERR" "no-such-task"
test_pass

# ── A task waiting for input ─────────────────────────────────

test_case "a task in input_required is reported, not answered"
run_mcpc --json "$SESSION" tools-call --detach slow-task ms:=200 steps:=2 needsInput:=true
assert_success
INPUT_ID=$(json_get '.taskId')
# The task parks after its first step
if ! wait_for_task_status "$INPUT_ID" input_required; then
  test_fail "task should reach input_required"
  exit 1
fi
run_mcpc "$SESSION" tasks-get "$INPUT_ID"
assert_success
assert_contains "$STDOUT" "input_required"
assert_contains "$STDOUT" "Waiting for: elicitation/create"
run_mcpc "$SESSION" tasks-result "$INPUT_ID"
assert_failure
assert_exit_code 2
assert_contains "$STDERR" "waiting for input from the client (elicitation/create)"
assert_contains "$STDERR" "tasks-cancel $INPUT_ID"
run_mcpc "$SESSION" tasks-cancel "$INPUT_ID"
assert_success
assert_contains "$STDOUT" "cancelled"
test_pass

# ── tasks-list: the tasks this session created ───────────────

test_case "tasks-list shows the tasks this session created, with their current status"
run_mcpc "$SESSION" tasks-list
assert_success
assert_contains "$STDOUT" "Tasks started from this session"
assert_contains "$STDOUT" "$TASK_ID"
assert_contains "$STDOUT" "$CANCEL_ID"
assert_contains "$STDOUT" "keep no task listing"
run_mcpc --json "$SESSION" tasks-list
assert_success
assert_json "$STDOUT" '[.tasks[] | select(.taskId == "'"$TASK_ID"'")][0].status == "completed"'
assert_json "$STDOUT" '[.tasks[] | select(.taskId == "'"$CANCEL_ID"'")][0].status == "cancelled"'
test_pass

test_case "cleanup: close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
