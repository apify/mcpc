#!/bin/bash
# Test: OAuth authentication with remote MCP server (mcp.apify.com)
# Prerequisites: OAuth profiles must be set up (see test/README.md)
#   mcpc mcp.apify.com login --profile e2e-test1
#   mcpc mcp.apify.com login --profile e2e-test2

source "$(dirname "$0")/../../lib/framework.sh"
test_init "auth/oauth-remote"

# Remote server URL
REMOTE_SERVER="mcp.apify.com"
PROFILE1="e2e-test1"
PROFILE2="e2e-test2"

# Set to "true" to test with only one profile (for debugging interference issues)
SINGLE_PROFILE_MODE="${SINGLE_PROFILE_MODE:-false}"

# =============================================================================
# Helper: Check if OAuth profile exists
# =============================================================================

check_profile_exists() {
  local profile="$1"
  # Check profiles.json for the profile
  local profiles_file="$HOME/.mcpc/profiles.json"
  if [[ ! -f "$profiles_file" ]]; then
    return 1
  fi

  # Check if profile exists for this server
  # Try both with and without https:// prefix (profiles use bare hostname)
  if jq -e ".profiles[\"$REMOTE_SERVER\"][\"$profile\"]" "$profiles_file" >/dev/null 2>&1; then
    return 0
  fi
  if jq -e ".profiles[\"https://$REMOTE_SERVER\"][\"$profile\"]" "$profiles_file" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# =============================================================================
# Prerequisite check: OAuth profiles must exist
# =============================================================================

test_case "prerequisite: check OAuth profile $PROFILE1 exists"
if ! check_profile_exists "$PROFILE1"; then
  # Write setup reminder file for the test runner to display
  mkdir -p "$_TEST_RUN_DIR"
  cat > "$_TEST_RUN_DIR/.setup_required" << EOF
OAuth E2E tests require authentication profiles to be configured.

To set up the required profiles, run:

  mcpc $REMOTE_SERVER login --profile $PROFILE1
  mcpc $REMOTE_SERVER login --profile $PROFILE2

You'll need a free Apify account: https://console.apify.com/sign-up
EOF

  test_skip "OAuth profile '$PROFILE1' not configured"

  # Skip all remaining tests
  test_case "prerequisite: check OAuth profile $PROFILE2 exists"
  test_skip "Skipped due to missing $PROFILE1"

  test_done
fi
test_pass

test_case "prerequisite: check OAuth profile $PROFILE2 exists"
if [[ "$SINGLE_PROFILE_MODE" == "true" ]]; then
  test_skip "Single profile mode enabled"
elif ! check_profile_exists "$PROFILE2"; then
  # Write setup reminder file for the test runner to display
  mkdir -p "$_TEST_RUN_DIR"
  cat > "$_TEST_RUN_DIR/.setup_required" << EOF
OAuth E2E tests require authentication profiles to be configured.

To set up the required profiles, run:

  mcpc $REMOTE_SERVER login --profile $PROFILE2

You'll need a free Apify account: https://console.apify.com/sign-up
EOF

  test_skip "OAuth profile '$PROFILE2' not configured"
  test_done
else
  test_pass
fi

# =============================================================================
# Setup: Copy user's OAuth profiles to test environment
# =============================================================================
# The test framework uses an isolated MCPC_HOME_DIR, but OAuth profiles are
# stored in the user's ~/.mcpc directory. Copy them so mcpc can use them.
# (OAuth tokens are stored in the system keychain, which is accessible globally)

test_case "setup: copy OAuth profiles to test environment"
USER_PROFILES="$HOME/.mcpc/profiles.json"
if [[ -f "$USER_PROFILES" ]]; then
  cp "$USER_PROFILES" "$MCPC_HOME_DIR/profiles.json"
fi
test_pass

# =============================================================================
# Test: One-shot commands (direct connection, no session)
# =============================================================================

test_case "one-shot: server info with OAuth profile"
run_mcpc "$REMOTE_SERVER" --profile "$PROFILE1"
assert_success
assert_contains "$STDOUT" "Apify"
assert_contains "$STDOUT" "Capabilities:"
test_pass

test_case "one-shot: ping with OAuth"
run_mcpc "$REMOTE_SERVER" ping --profile "$PROFILE1"
assert_success
assert_contains "$STDOUT" "Ping successful"
test_pass

test_case "one-shot: ping --json returns valid JSON"
run_mcpc --json "$REMOTE_SERVER" ping --profile "$PROFILE1"
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '.durationMs'
test_pass

test_case "one-shot: tools-list with OAuth"
# Note: Using run_mcpc instead of run_xmcpc because remote server output
# may vary between calls (non-deterministic ordering, dynamic data)
run_mcpc "$REMOTE_SERVER" tools-list --profile "$PROFILE1"
assert_success
assert_not_empty "$STDOUT"
test_pass

test_case "one-shot: tools-list --json returns valid array"
run_mcpc --json "$REMOTE_SERVER" tools-list --profile "$PROFILE1"
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '. | type == "array"'
assert_json "$STDOUT" '. | length > 0'
test_pass

test_case "one-shot: resources-list with OAuth"
run_mcpc "$REMOTE_SERVER" resources-list --profile "$PROFILE1"
assert_success
# May have resources or be empty, just check it doesn't error
test_pass

test_case "one-shot: resources-list --json returns valid array"
run_mcpc --json "$REMOTE_SERVER" resources-list --profile "$PROFILE1"
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '. | type == "array"'
test_pass

test_case "one-shot: prompts-list with OAuth"
run_mcpc "$REMOTE_SERVER" prompts-list --profile "$PROFILE1"
assert_success
# May have prompts or be empty, just check it doesn't error
test_pass

test_case "one-shot: prompts-list --json returns valid array"
run_mcpc --json "$REMOTE_SERVER" prompts-list --profile "$PROFILE1"
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '. | type == "array"'
test_pass

test_case "one-shot: help shows available commands"
run_mcpc "$REMOTE_SERVER" help --profile "$PROFILE1"
assert_success
assert_contains "$STDOUT" "Available commands:"
test_pass

test_case "one-shot: different profile works independently"
if [[ "$SINGLE_PROFILE_MODE" == "true" ]]; then
  test_skip "Single profile mode enabled"
else
  # Verify that using a different profile also works
  run_mcpc "$REMOTE_SERVER" ping --profile "$PROFILE2"
  assert_success
  assert_contains "$STDOUT" "Ping successful"
  test_pass
fi

# =============================================================================
# Test: Session with OAuth profile
# =============================================================================

test_case "create session with OAuth profile (verbose)"
SESSION1=$(session_name "oauth1")
# Create session with verbose mode to check for credential leaks
run_mcpc --verbose "$REMOTE_SERVER" session "$SESSION1" --profile "$PROFILE1"
assert_success
_SESSIONS_CREATED+=("$SESSION1")

# Check that verbose session creation doesn't leak OAuth tokens
ALL_OUTPUT="$STDOUT$STDERR"

if echo "$ALL_OUTPUT" | grep -iE 'Bearer [A-Za-z0-9_-]{20,}' >/dev/null 2>&1; then
  test_fail "Verbose session creation contains Bearer token"
  exit 1
fi

if echo "$ALL_OUTPUT" | grep -iE '"access_token"\s*:\s*"[^"]{20,}"' >/dev/null 2>&1; then
  test_fail "Verbose session creation contains access_token"
  exit 1
fi

if echo "$ALL_OUTPUT" | grep -iE '"refresh_token"\s*:\s*"[^"]{20,}"' >/dev/null 2>&1; then
  test_fail "Verbose session creation contains refresh_token"
  exit 1
fi

if echo "$ALL_OUTPUT" | grep -iE 'Authorization:\s*[A-Za-z]+\s+[A-Za-z0-9_-]{20,}' >/dev/null 2>&1; then
  test_fail "Verbose session creation contains Authorization header with token"
  exit 1
fi
test_pass

test_case "session tools-list works"
run_mcpc "$SESSION1" tools-list
assert_success
assert_not_empty "$STDOUT"
test_pass

test_case "session ping works"
run_mcpc "$SESSION1" ping
assert_success
test_pass

test_case "session info shows server capabilities"
run_mcpc "$SESSION1"
assert_success
assert_contains "$STDOUT" "Capabilities:"
test_pass

# =============================================================================
# Test: Different profiles create independent sessions
# =============================================================================

test_case "create second session with different profile (verbose)"
if [[ "$SINGLE_PROFILE_MODE" == "true" ]]; then
  test_skip "Single profile mode enabled"
else
  SESSION2=$(session_name "oauth2")
  # Create session with verbose mode to check for credential leaks
  run_mcpc --verbose "$REMOTE_SERVER" session "$SESSION2" --profile "$PROFILE2"
  assert_success
  _SESSIONS_CREATED+=("$SESSION2")

  # Check that verbose session creation doesn't leak OAuth tokens
  ALL_OUTPUT="$STDOUT$STDERR"

  if echo "$ALL_OUTPUT" | grep -iE 'Bearer [A-Za-z0-9_-]{20,}' >/dev/null 2>&1; then
    test_fail "Verbose session creation (profile2) contains Bearer token"
    exit 1
  fi

  if echo "$ALL_OUTPUT" | grep -iE '"access_token"\s*:\s*"[^"]{20,}"' >/dev/null 2>&1; then
    test_fail "Verbose session creation (profile2) contains access_token"
    exit 1
  fi

  if echo "$ALL_OUTPUT" | grep -iE 'Authorization:\s*[A-Za-z]+\s+[A-Za-z0-9_-]{20,}' >/dev/null 2>&1; then
    test_fail "Verbose session creation (profile2) contains Authorization header"
    exit 1
  fi
  test_pass
fi

test_case "both sessions work independently"
if [[ "$SINGLE_PROFILE_MODE" == "true" ]]; then
  test_skip "Single profile mode enabled"
else
  # Session 1
  run_mcpc "$SESSION1" ping
  assert_success

  # Session 2
  run_mcpc "$SESSION2" ping
  assert_success
  test_pass
fi

test_case "session list shows both sessions"
if [[ "$SINGLE_PROFILE_MODE" == "true" ]]; then
  test_skip "Single profile mode enabled"
else
  run_mcpc --json
  assert_success
  assert_json_valid "$STDOUT"

  # Check both sessions exist
  sessions_json="$STDOUT"
  session1_exists=$(echo "$sessions_json" | jq -r ".sessions[] | select(.name == \"$SESSION1\") | .name")
  session2_exists=$(echo "$sessions_json" | jq -r ".sessions[] | select(.name == \"$SESSION2\") | .name")

  if [[ "$session1_exists" != "$SESSION1" ]]; then
    test_fail "Session $SESSION1 not found in session list"
    exit 1
  fi
  if [[ "$session2_exists" != "$SESSION2" ]]; then
    test_fail "Session $SESSION2 not found in session list"
    exit 1
  fi
  test_pass
fi

# =============================================================================
# Test: Session shows profile information
# =============================================================================

test_case "sessions list shows profile name"
run_mcpc --json
assert_success
assert_json_valid "$STDOUT"
# The session should reference the profile in the sessions list
profile_name=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$SESSION1\") | .profileName")
if [[ "$profile_name" != "$PROFILE1" ]]; then
  test_fail "Profile name $PROFILE1 not found for session $SESSION1 (got: $profile_name)"
  exit 1
fi
test_pass

# =============================================================================
# Test: Security - no sensitive tokens in logs
# =============================================================================

test_case "verbose output does not leak OAuth tokens"
# Run with verbose mode and capture all output
run_mcpc --verbose "$SESSION1" ping
assert_success

# Combine stdout and stderr for security check
ALL_OUTPUT="$STDOUT$STDERR"

# Check that common OAuth token patterns are NOT present
# Bearer tokens (Authorization header value)
if echo "$ALL_OUTPUT" | grep -iE 'Bearer [A-Za-z0-9_-]{20,}' >/dev/null 2>&1; then
  test_fail "Verbose output contains Bearer token"
  exit 1
fi

# Access tokens (typically long base64-like strings in auth contexts)
if echo "$ALL_OUTPUT" | grep -iE '"access_token"\s*:\s*"[^"]{20,}"' >/dev/null 2>&1; then
  test_fail "Verbose output contains access_token"
  exit 1
fi

# Refresh tokens
if echo "$ALL_OUTPUT" | grep -iE '"refresh_token"\s*:\s*"[^"]{20,}"' >/dev/null 2>&1; then
  test_fail "Verbose output contains refresh_token"
  exit 1
fi

# Authorization header with any long value
if echo "$ALL_OUTPUT" | grep -iE 'Authorization:\s*[A-Za-z]+\s+[A-Za-z0-9_-]{20,}' >/dev/null 2>&1; then
  test_fail "Verbose output contains Authorization header with token"
  exit 1
fi
test_pass

test_case "bridge log does not leak OAuth tokens"
# Get the bridge log path
BRIDGE_LOG="$MCPC_HOME_DIR/logs/bridge-$SESSION1.log"

if [[ -f "$BRIDGE_LOG" ]]; then
  LOG_CONTENT=$(cat "$BRIDGE_LOG")

  # Check that common OAuth token patterns are NOT present in logs
  if echo "$LOG_CONTENT" | grep -iE 'Bearer [A-Za-z0-9_-]{20,}' >/dev/null 2>&1; then
    test_fail "Bridge log contains Bearer token"
    exit 1
  fi

  if echo "$LOG_CONTENT" | grep -iE '"access_token"\s*:\s*"[^"]{20,}"' >/dev/null 2>&1; then
    test_fail "Bridge log contains access_token"
    exit 1
  fi

  if echo "$LOG_CONTENT" | grep -iE '"refresh_token"\s*:\s*"[^"]{20,}"' >/dev/null 2>&1; then
    test_fail "Bridge log contains refresh_token"
    exit 1
  fi

  if echo "$LOG_CONTENT" | grep -iE 'Authorization:\s*[A-Za-z]+\s+[A-Za-z0-9_-]{20,}' >/dev/null 2>&1; then
    test_fail "Bridge log contains Authorization header with token"
    exit 1
  fi
fi
test_pass

test_case "verbose direct command does not leak OAuth tokens"
# Test direct connection (no session) with verbose mode
run_mcpc --verbose "$REMOTE_SERVER" ping --profile "$PROFILE1"
assert_success

ALL_OUTPUT="$STDOUT$STDERR"

# Check for token leaks in direct mode
if echo "$ALL_OUTPUT" | grep -iE 'Bearer [A-Za-z0-9_-]{20,}' >/dev/null 2>&1; then
  test_fail "Verbose direct command output contains Bearer token"
  exit 1
fi

if echo "$ALL_OUTPUT" | grep -iE '"access_token"\s*:\s*"[^"]{20,}"' >/dev/null 2>&1; then
  test_fail "Verbose direct command output contains access_token"
  exit 1
fi

if echo "$ALL_OUTPUT" | grep -iE 'Authorization:\s*[A-Za-z]+\s+[A-Za-z0-9_-]{20,}' >/dev/null 2>&1; then
  test_fail "Verbose direct command output contains Authorization header"
  exit 1
fi
test_pass

# =============================================================================
# Test: Close sessions
# =============================================================================

test_case "close first session"
run_mcpc "$SESSION1" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION1}")
test_pass

test_case "close second session"
if [[ "$SINGLE_PROFILE_MODE" == "true" ]]; then
  test_skip "Single profile mode enabled"
else
  run_mcpc "$SESSION2" close
  assert_success
  _SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION2}")
  test_pass
fi

test_case "sessions no longer in list after close"
run_mcpc --json
assert_success
assert_json_valid "$STDOUT"

# Check sessions are gone
if echo "$STDOUT" | jq -e ".sessions[] | select(.name == \"$SESSION1\")" >/dev/null 2>&1; then
  test_fail "Session $SESSION1 still exists after close"
  exit 1
fi
if [[ "$SINGLE_PROFILE_MODE" != "true" ]]; then
  if echo "$STDOUT" | jq -e ".sessions[] | select(.name == \"$SESSION2\")" >/dev/null 2>&1; then
    test_fail "Session $SESSION2 still exists after close"
    exit 1
  fi
fi
test_pass

test_done
