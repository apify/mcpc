#!/bin/bash
# Test: Session notification tracking (listChanged timestamps)

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/notifications"

# Start test server
start_test_server

# Generate unique session name for this test
SESSION=$(session_name "notif")

# Read the session's listChangedAt timestamp for one list type ("null" when absent).
notification_timestamp() {
  $MCPC --json 2>/dev/null |
    jq -r ".sessions[] | select(.name == \"$SESSION\") | .notifications.$1.listChangedAt // \"null\""
}

# The bridge records the timestamp asynchronously: the notification arrives over the
# server's SSE stream, the SDK re-fetches the list first for prompts and resources, and
# the write then queues behind every other suite of a parallel run for the sessions.json
# lock. Poll for it instead of sleeping a fixed second, which raced under CI load.
wait_for_notification() {
  wait_for "[[ \"\$(notification_timestamp $1)\" != null ]]" 15 || true
}

# Test: create session
test_case "connect creates session"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success "connect should succeed"
assert_contains "$STDOUT" "created"
_SESSIONS_CREATED+=("$SESSION")
test_pass

# Test: session initially has no notification timestamps
test_case "session has no notifications initially"
run_mcpc --json
assert_success
# Check that the session exists but has no notifications
session_json=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$SESSION\")")
assert_not_empty "$session_json" "session should exist"
# notifications field may not exist or be empty
notif_tools=$(echo "$session_json" | jq -r '.notifications.tools.listChangedAt // "null"')
assert_eq "$notif_tools" "null" "tools notification should not exist initially"
test_pass

# Test: trigger tools/list_changed notification
test_case "trigger tools/list_changed updates timestamp"
server_notify_tools_changed
wait_for_notification tools
run_mcpc --json
assert_success
session_json=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$SESSION\")")
notif_tools=$(echo "$session_json" | jq -r '.notifications.tools.listChangedAt // "null"')
assert_not_empty "$notif_tools" "tools notification timestamp should exist"
if [[ "$notif_tools" == "null" ]]; then
  test_fail "tools notification timestamp should not be null"
  exit 1
fi
test_pass

# Save the tools timestamp for later comparison
TOOLS_TIMESTAMP="$notif_tools"

# Test: trigger prompts/list_changed notification
test_case "trigger prompts/list_changed updates timestamp"
server_notify_prompts_changed
wait_for_notification prompts
run_mcpc --json
assert_success
session_json=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$SESSION\")")
notif_prompts=$(echo "$session_json" | jq -r '.notifications.prompts.listChangedAt // "null"')
assert_not_empty "$notif_prompts" "prompts notification timestamp should exist"
if [[ "$notif_prompts" == "null" ]]; then
  test_fail "prompts notification timestamp should not be null"
  exit 1
fi
# Tools timestamp should still be preserved
notif_tools=$(echo "$session_json" | jq -r '.notifications.tools.listChangedAt // "null"')
assert_eq "$notif_tools" "$TOOLS_TIMESTAMP" "tools timestamp should be preserved"
test_pass

# Test: trigger resources/list_changed notification
test_case "trigger resources/list_changed updates timestamp"
server_notify_resources_changed
wait_for_notification resources
run_mcpc --json
assert_success
session_json=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$SESSION\")")
notif_resources=$(echo "$session_json" | jq -r '.notifications.resources.listChangedAt // "null"')
assert_not_empty "$notif_resources" "resources notification timestamp should exist"
if [[ "$notif_resources" == "null" ]]; then
  test_fail "resources notification timestamp should not be null"
  exit 1
fi
test_pass

# Test: close session
test_case "close session"
run_mcpc "$SESSION" close
assert_success
assert_contains "$STDOUT" "closed"
test_pass

# Remove from cleanup list since we already closed it
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")

test_done
