#!/bin/bash
# Test: Authentication error handling

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/auth-errors"

# Start test server with auth required
start_test_server REQUIRE_AUTH=true

# Test: tools-list without auth fails with 401
test_case "tools-list without auth fails"
run_xmcpc "$TEST_SERVER_URL" tools-list
assert_failure
# Should contain some indication of auth failure (401, unauthorized, etc.)
# Just verify we get an error - exact message depends on implementation
assert_not_empty "$STDERR" "should have error message"
test_pass

# Test: JSON error output for auth failure
test_case "auth failure returns JSON error"
run_mcpc "$TEST_SERVER_URL" tools-list --json
assert_failure
assert_json_valid "$STDERR"
test_pass

# Test: auth error with session
test_case "session without auth fails on first use"
SESSION=$(session_name "auth-fail")
run_mcpc "$TEST_SERVER_URL" session "$SESSION"
# Session creation might succeed (just stores config)
# But using it should fail due to auth
run_xmcpc "$SESSION" tools-list
assert_failure
test_pass

# Clean up - close session if it was created
run_mcpc "$SESSION" close 2>/dev/null || true

# Test: tools-call without auth fails
test_case "tools-call without auth fails"
run_xmcpc "$TEST_SERVER_URL" tools-call echo --args '{"message":"test"}'
assert_failure
test_pass

# Test: resources-list without auth fails
test_case "resources-list without auth fails"
run_xmcpc "$TEST_SERVER_URL" resources-list
assert_failure
test_pass

# Test: prompts-list without auth fails
test_case "prompts-list without auth fails"
run_xmcpc "$TEST_SERVER_URL" prompts-list
assert_failure
test_pass

# =============================================================================
# Test: OAuth-enabled remote server without profile hints at login
# =============================================================================

# Use mcp.sentry.dev which requires OAuth authentication
OAUTH_SERVER="https://mcp.sentry.dev/mcp"

test_case "OAuth server without profile shows login hint"
run_mcpc "$OAUTH_SERVER" tools-list
assert_failure
# Should hint at login command
assert_contains "$STDERR" "login"
assert_contains "$STDERR" "authenticate"
test_pass

test_case "OAuth server without profile (JSON) shows login hint"
run_mcpc --json "$OAUTH_SERVER" tools-list
assert_failure
assert_json_valid "$STDERR"
# JSON error should also contain login hint
error_msg=$(echo "$STDERR" | jq -r '.error // empty')
if [[ -z "$error_msg" ]] || ! echo "$error_msg" | grep -qi "login"; then
  test_fail "JSON error should contain login hint"
  exit 1
fi
test_pass

test_case "OAuth server session creation without profile shows login hint"
SESSION=$(session_name "oauth-noprof")
run_mcpc "$OAUTH_SERVER" session "$SESSION"
assert_failure
# Should hint at login command
assert_contains "$STDERR" "login"
test_pass

test_done
