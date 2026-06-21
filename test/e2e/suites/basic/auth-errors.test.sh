#!/bin/bash
# Test: Authentication error handling

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/auth-errors"

# Start test server with auth required
start_test_server REQUIRE_AUTH=true

# Create a session without proper auth credentials (no auth header)
# Session creation may or may not succeed depending on timing
AUTH_SESSION=$(session_name "auth")
run_mcpc connect "$TEST_SERVER_URL" "$AUTH_SESSION"
# Don't assert here - session creation might fail immediately (auth error) or succeed
# Either way, subsequent commands on the session should fail

# Test: tools-list without auth fails
test_case "tools-list without auth fails"
run_xmcpc "$AUTH_SESSION" tools-list
assert_failure
# Should contain some indication of auth failure (401, unauthorized, etc.)
assert_not_empty "$STDERR" "should have error message"
test_pass

# Test: JSON error output for auth failure
test_case "auth failure returns JSON error"
run_mcpc "$AUTH_SESSION" tools-list --json
assert_failure
assert_json_valid "$STDERR"
test_pass

# Test: auth error with session
test_case "session without auth fails on first use"
SESSION=$(session_name "auth-fail")
run_mcpc connect "$TEST_SERVER_URL" "$SESSION"
# Session creation might succeed (just stores config)
# But using it should fail due to auth
run_xmcpc "$SESSION" tools-list
assert_failure
test_pass

# Clean up - close session if it was created
run_mcpc "$SESSION" close 2>/dev/null || true

# Test: tools-call without auth fails
test_case "tools-call without auth fails"
run_xmcpc "$AUTH_SESSION" tools-call echo '{"message":"test"}'
assert_failure
test_pass

# Test: resources-list without auth fails
test_case "resources-list without auth fails"
run_xmcpc "$AUTH_SESSION" resources-list
assert_failure
test_pass

# Test: prompts-list without auth fails
test_case "prompts-list without auth fails"
run_xmcpc "$AUTH_SESSION" prompts-list
assert_failure
test_pass

# Clean up auth session
run_mcpc "$AUTH_SESSION" close 2>/dev/null || true

# =============================================================================
# Test: Auth-required server without credentials hints at login
# =============================================================================

# Use the local test server (already started with REQUIRE_AUTH=true)
# This avoids depending on external servers which makes tests flaky

test_case "Auth-required server session creation shows login hint"
SESSION=$(session_name "auth-noprof")
run_mcpc connect "$TEST_SERVER_URL" "$SESSION"
assert_failure
# Should hint at login command
assert_contains "$STDERR" "login"
test_pass

test_case "Auth-required server session creation (JSON) shows login hint"
SESSION=$(session_name "auth-noprof2")
run_mcpc --json connect "$TEST_SERVER_URL" "$SESSION"
assert_failure
assert_json_valid "$STDERR"
# JSON error should also contain login hint
error_msg=$(echo "$STDERR" | jq -r '.error // empty')
if [[ -z "$error_msg" ]] || ! echo "$error_msg" | grep -qi "login"; then
  test_fail "JSON error should contain login hint"
  exit 1
fi
test_pass

# NOTE: CLI-side `login` flag validation (client registration approaches, CIMD,
# --callback-host / --callback-port) lives in basic/login-flags so this suite
# stays within its per-test time budget. Add such tests there, not here.

test_done
