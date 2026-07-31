#!/bin/bash
# Test: Resource subscription file sync (resources-subscribe / resources-unsubscribe)
# The bridge downloads the subscribed resource to a local file and rewrites it
# whenever the server sends notifications/resources/updated for the URI.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/resource-sync"

# Start test server
start_test_server

SESSION=$(session_name "rsync")
COUNTER_URI="test://dynamic/counter"
SYNC_FILE="$TEST_TMP/counter-sync.txt"

# Wait (up to timeout secs) for a file to contain exactly the expected line
wait_for_file_content() {
  local path="$1"
  local expected="$2"
  local timeout="${3:-10}"
  local i
  for ((i = 0; i < timeout * 10; i++)); do
    if [[ -f "$path" ]] && grep -qx "$expected" "$path" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

# Wait (up to timeout secs) until the server tracks a subscription for the URI
wait_for_server_subscription() {
  local uri="$1"
  local timeout="${2:-10}"
  local i
  for ((i = 0; i < timeout * 10; i++)); do
    if [[ "$(server_get_subscriptions)" == *"$uri"* ]]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

test_case "setup: create session"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

# =============================================================================
# Test: resources-subscribe
# =============================================================================

test_case "resources-subscribe without file argument fails"
run_mcpc "$SESSION" resources-subscribe "$COUNTER_URI"
assert_failure
assert_contains "$STDERR" "file"
test_pass

test_case "resources-subscribe downloads initial content"
run_mcpc "$SESSION" resources-subscribe "$COUNTER_URI" "$SYNC_FILE"
assert_success
assert_contains "$STDOUT" "Subscribed"
assert_file_exists "$SYNC_FILE"
assert_eq "$(cat "$SYNC_FILE")" "counter=0" "initial sync should download current content"
test_pass

test_case "server records the subscription"
if [[ "$E2E_SERVER_PROTOCOL" == "modern" ]]; then
  # 2026-07-28 subscriptions live in the client's subscriptions/listen stream;
  # the server keeps no per-session subscription registry to inspect.
  test_skip "server-side subscription registry is a 2025-era concept"
elif ! wait_for_server_subscription "$COUNTER_URI" 5; then
  test_fail "server should track the subscription: $(server_get_subscriptions)"
  exit 1
else
  test_pass
fi

test_case "session info shows the subscription"
run_mcpc --json "$SESSION"
assert_success
assert_json "$STDOUT" "._mcpc.resourceSubscriptions[0].uri == \"$COUNTER_URI\""
assert_json "$STDOUT" '._mcpc.resourceSubscriptions[0].filePath | length > 0'
test_pass

test_case "session info human output lists the subscription"
run_mcpc "$SESSION"
assert_success
assert_contains "$STDOUT" "Resource subscriptions:"
assert_contains "$STDOUT" "$COUNTER_URI"
test_pass

# =============================================================================
# Test: resources/updated notifications re-sync the file
# =============================================================================

test_case "resources/updated notification re-syncs the file"
server_bump_counter >/dev/null
if ! wait_for_file_content "$SYNC_FILE" "counter=1"; then
  test_fail "file should be re-synced to counter=1 (got: $(cat "$SYNC_FILE" 2>/dev/null))"
  exit 1
fi
test_pass

test_case "subsequent updates keep syncing"
server_bump_counter >/dev/null
if ! wait_for_file_content "$SYNC_FILE" "counter=2"; then
  test_fail "file should be re-synced to counter=2 (got: $(cat "$SYNC_FILE" 2>/dev/null))"
  exit 1
fi
test_pass

test_case "updated notifications for unsubscribed URIs are ignored"
# Fault injection: notify about an unrelated URI; the synced file must not change
server_notify_resource_updated "test://static/hello"
sleep 1
assert_eq "$(cat "$SYNC_FILE")" "counter=2" "file should be unchanged"
test_pass

# =============================================================================
# Test: subscriptions survive a session restart
# =============================================================================

test_case "subscription survives session restart"
run_mcpc "$SESSION" restart
assert_success
# The bridge re-subscribes and re-syncs in the background after reconnecting.
# On the modern server there is no registry to poll, so give the re-opened
# subscriptions/listen stream a moment to be established instead.
if [[ "$E2E_SERVER_PROTOCOL" == "modern" ]]; then
  sleep 2
elif ! wait_for_server_subscription "$COUNTER_URI" 10; then
  test_fail "subscription should be re-established on the server after restart"
  exit 1
fi
server_bump_counter >/dev/null
if ! wait_for_file_content "$SYNC_FILE" "counter=3"; then
  test_fail "file should keep syncing after restart (got: $(cat "$SYNC_FILE" 2>/dev/null))"
  exit 1
fi
test_pass

# =============================================================================
# Test: resources-unsubscribe
# =============================================================================

test_case "resources-unsubscribe stops syncing and keeps the file"
run_mcpc "$SESSION" resources-unsubscribe "$COUNTER_URI"
assert_success
assert_contains "$STDOUT" "Unsubscribed"
assert_contains "$STDOUT" "File kept"
assert_file_exists "$SYNC_FILE"
test_pass

test_case "server subscription is removed"
if [[ "$E2E_SERVER_PROTOCOL" == "modern" ]]; then
  test_skip "server-side subscription registry is a 2025-era concept"
else
  SUBS_JSON=$(server_get_subscriptions)
  if [[ "$SUBS_JSON" == *"$COUNTER_URI"* ]]; then
    test_fail "server should no longer track the subscription: $SUBS_JSON"
    exit 1
  fi
  test_pass
fi

test_case "no more syncing after unsubscribe"
server_bump_counter >/dev/null
# Even fault-injected updated notifications must be ignored now
server_notify_resource_updated "$COUNTER_URI"
sleep 1.5
assert_eq "$(cat "$SYNC_FILE")" "counter=3" "file should keep the last synced content"
test_pass

test_case "unsubscribe without subscription fails with guidance"
run_mcpc "$SESSION" resources-unsubscribe "$COUNTER_URI"
assert_failure
assert_contains "$STDERR" "No active subscription"
test_pass

# =============================================================================
# Test: error handling and JSON mode
# =============================================================================

test_case "subscribe to unknown resource fails and rolls back"
run_mcpc "$SESSION" resources-subscribe "test://nonexistent" "$TEST_TMP/never.txt"
assert_failure
assert_file_not_exists "$TEST_TMP/never.txt"
test_pass

test_case "subscribe --json returns sync summary"
JSON_SYNC_FILE="$TEST_TMP/counter-json.txt"
run_mcpc --json "$SESSION" resources-subscribe "$COUNTER_URI" "$JSON_SYNC_FILE"
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '.subscribed == true'
assert_json "$STDOUT" ".uri == \"$COUNTER_URI\""
assert_json "$STDOUT" '.bytes > 0'
assert_json "$STDOUT" '.mimeType == "text/plain"'
assert_file_exists "$JSON_SYNC_FILE"
test_pass

test_case "unsubscribe --json returns kept file path"
run_mcpc --json "$SESSION" resources-unsubscribe "$COUNTER_URI"
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '.unsubscribed == true'
assert_json "$STDOUT" '.file | length > 0'
assert_file_exists "$JSON_SYNC_FILE"
test_pass

# =============================================================================
# Cleanup
# =============================================================================

test_case "cleanup: close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
