#!/bin/bash
# Test: Sessions that fail with 401 and have no OAuth profile stay 'unauthorized'
# across `mcpc` invocations, even after the auto-retry cooldown has elapsed.
# Also verifies the auth error message points at the bridge log file.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/unauthorized-persist" --isolated

# Start test server requiring auth. The server's auth check accepts any
# "Bearer <anything>" value, so sending an Authorization header that doesn't
# match that shape is enough to trigger 401.
start_test_server REQUIRE_AUTH=true

SESSION=$(session_name "unauth")
_SESSIONS_CREATED+=("$SESSION")

# =============================================================================
# Test: bearer-only session fails with auth error containing log path
# =============================================================================

test_case "connect with bad bearer token fails with auth error + logs hint"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" \
  --header "X-Test: true" \
  --header "Authorization: InvalidScheme not-a-bearer-token"
assert_failure
assert_exit_code 4 "should fail with auth exit code (4)"
assert_contains "$STDERR" "Authentication required by server"
# The error should point at the new logs command so the user can investigate
assert_contains "$STDERR" "mcpc ${SESSION} logs"
test_pass

# =============================================================================
# Test: session is marked unauthorized right after the failed connect
# =============================================================================

test_case "failed bearer session reports 'unauthorized' status"
run_mcpc --json
assert_success
session_status=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$SESSION\") | .status")
if [[ "$session_status" != "unauthorized" ]]; then
  test_fail "expected status 'unauthorized', got: '$session_status'"
  exit 1
fi
test_pass

# =============================================================================
# Test: unauthorized bearer session does NOT flip back to 'connecting'
# after the auto-retry cooldown expires.
#
# Before the fix, consolidateSessions() treated all unauthorized sessions as
# retry candidates and reset the status to 'connecting' on every `mcpc` call
# (after the 10s cooldown), which both hid the real state from the user and
# triggered pointless background bridge restarts. Bearer-only sessions cannot
# self-heal because the token never changes.
# =============================================================================

test_case "unauthorized bearer session stays unauthorized past the cooldown"
sessions_file="$MCPC_HOME_DIR/sessions.json"
assert_file_exists "$sessions_file"

# Age the lastConnectionAttemptAt timestamp well past the 10s cooldown and
# clear the bridge pid to simulate the bridge having exited — that's the real
# state consolidateSessions() sees when the user runs `mcpc` well after the
# original failed connect. Leaving pid set would short-circuit the retry path
# via `!session.pid`, hiding the bug we are trying to catch.
old_iso="2000-01-01T00:00:00.000Z"
tmp_file="$TEST_TMP/sessions.json.$$"
jq --arg name "$SESSION" --arg when "$old_iso" \
  '.sessions[$name].lastConnectionAttemptAt = $when
   | del(.sessions[$name].pid)' \
  "$sessions_file" > "$tmp_file"
mv "$tmp_file" "$sessions_file"

# Re-run the list command — consolidateSessions() runs on every list.
run_mcpc --json
assert_success
session_status=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$SESSION\") | .status")
if [[ "$session_status" != "unauthorized" ]]; then
  test_fail "expected status to stay 'unauthorized' after cooldown, got: '$session_status'"
  exit 1
fi
test_pass

# =============================================================================
# Test: using an unauthorized session surfaces the auth error + log path
# =============================================================================

test_case "using unauthorized session surfaces auth error with logs hint"
run_mcpc "$SESSION" tools-list
assert_failure
assert_exit_code 4 "should fail with auth exit code (4)"
assert_contains "$STDERR" "Authentication required by server"
assert_contains "$STDERR" "mcpc ${SESSION} logs"
test_pass

test_done
