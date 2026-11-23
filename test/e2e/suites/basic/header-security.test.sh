#!/bin/bash
# Test: Header security (no leak in process list, redacted in storage)
# Ensures sensitive headers are not exposed in process arguments or stored in plaintext

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/header-security" --isolated

# Start test server
start_test_server

# Define a secret header value that should never appear in ps or sessions.json
# Note: We use X-Api-Key instead of Authorization because Authorization headers
# are specially handled by OAuth profile logic (deleted when profile exists).
SECRET_VALUE="super-secret-token-$(date +%s)"
SECRET_HEADER="X-Api-Key"

# =============================================================================
# Test: Headers don't leak in process list (ps aux)
# =============================================================================

test_case "secret header not visible in ps aux"
SESSION=$(session_name "sec-hdr")

# Create session with secret header
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true" --header "$SECRET_HEADER: Bearer $SECRET_VALUE"
assert_success
_SESSIONS_CREATED+=("$SESSION")

# Wait for bridge to be fully ready
wait_for "$MCPC $SESSION ping >/dev/null 2>&1"

# Check that the secret is not visible in process list
# This tests that we're not passing credentials as command-line arguments
ps_output=$(ps aux 2>/dev/null || ps -ef 2>/dev/null || echo "")
if echo "$ps_output" | grep -q "$SECRET_VALUE"; then
  test_fail "Secret header value found in process list! This is a security vulnerability."
fi

# Verify the session is working (header was passed correctly via IPC)
run_mcpc "$SESSION" ping
assert_success

test_pass

# =============================================================================
# Test: Headers are redacted in sessions.json
# =============================================================================

test_case "headers are redacted in sessions.json"
# Read sessions.json and check that the secret is not there
sessions_file="$MCPC_HOME_DIR/sessions.json"
assert_file_exists "$sessions_file"

sessions_content=$(cat "$sessions_file")

# Secret value should NOT appear in sessions.json
if echo "$sessions_content" | grep -q "$SECRET_VALUE"; then
  test_fail "Secret header value found in sessions.json! Headers should be redacted."
fi

# The header key should be present but value should be <redacted>
if echo "$sessions_content" | grep -q '"<redacted>"'; then
  # Good - redacted value found
  :
else
  # Check if there are any headers at all - if headers weren't passed, this isn't a failure
  # Note: Headers are stored in keychain, not in sessions.json
  # The serverConfig.headers in sessions.json contains redacted values
  :
fi

test_pass

# =============================================================================
# Test: Session list shows redacted headers (human mode)
# =============================================================================

test_case "session info shows redacted in human mode"
run_mcpc "$SESSION"
assert_success

# The output should NOT contain the actual secret
if echo "$STDOUT" | grep -q "$SECRET_VALUE"; then
  test_fail "Secret header value found in session info output!"
fi

# The output might show <redacted> for headers if displayed
# (Note: Current implementation stores headers in keychain, redacted version in sessions.json)
test_pass

# =============================================================================
# Test: Session list shows redacted headers (JSON mode)
# =============================================================================

test_case "session list --json doesn't expose secrets"
run_mcpc --json
assert_success
assert_json_valid "$STDOUT"

# The JSON output should NOT contain the actual secret
if echo "$STDOUT" | grep -q "$SECRET_VALUE"; then
  test_fail "Secret header value found in JSON output!"
fi

# If headers are shown, they should be redacted
if echo "$STDOUT" | jq -e ".sessions[] | select(.name == \"$SESSION\") | .server.headers" >/dev/null 2>&1; then
  # Headers field exists - verify values are redacted
  header_value=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$SESSION\") | .server.headers[\"$SECRET_HEADER\"] // empty")
  if [[ -n "$header_value" && "$header_value" != "<redacted>" ]]; then
    test_fail "Header value not properly redacted in JSON output: $header_value"
  fi
fi

test_pass

# =============================================================================
# Test: Multiple headers all get redacted
# =============================================================================

test_case "multiple headers all redacted"
SESSION2=$(session_name "sec-multi")
ANOTHER_SECRET="another-secret-$(date +%s)"

run_mcpc connect "$TEST_SERVER_URL" "$SESSION2" \
  --header "X-Test: true" \
  --header "X-Api-Key: $SECRET_VALUE" \
  --header "X-Secret-Token: $ANOTHER_SECRET" \
  --header "X-Public: public-value"
assert_success
_SESSIONS_CREATED+=("$SESSION2")

# Wait for bridge to be fully ready before using session
wait_for "$MCPC $SESSION2 ping >/dev/null 2>&1"

# None of the secrets should appear in sessions.json
sessions_content=$(cat "$sessions_file")
if echo "$sessions_content" | grep -q "$SECRET_VALUE"; then
  test_fail "First secret found in sessions.json"
fi
if echo "$sessions_content" | grep -q "$ANOTHER_SECRET"; then
  test_fail "Second secret found in sessions.json"
fi

# Every repeated --header must be stored, not just the last one (#490)
run_mcpc --json
stored_keys=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$SESSION2\") | .server.headers | keys | sort | join(\",\")")
assert_eq "$stored_keys" "X-Api-Key,X-Public,X-Secret-Token,X-Test" "all repeated headers should be stored"

# But headers should still work for requests
run_mcpc "$SESSION2" ping
assert_success

# Clean up
run_mcpc "$SESSION2" close >/dev/null 2>&1
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION2}")
test_pass

# =============================================================================
# Test: Verbose output doesn't leak secrets
# =============================================================================

test_case "verbose session creation doesn't leak secrets"
SESSION3=$(session_name "sec-verb")
VERBOSE_SECRET="verbose-secret-$(date +%s)"

# Create session with verbose mode
run_mcpc --verbose connect "$TEST_SERVER_URL" "$SESSION3" --header "X-Test: true" --header "X-Api-Key: $VERBOSE_SECRET"
assert_success
_SESSIONS_CREATED+=("$SESSION3")

# Combine stdout and stderr for security check
ALL_OUTPUT="$STDOUT$STDERR"

# Check that secret is NOT in verbose output
if echo "$ALL_OUTPUT" | grep -q "$VERBOSE_SECRET"; then
  test_fail "Secret header value found in verbose session creation output!"
fi

# API key patterns should not appear
if echo "$ALL_OUTPUT" | grep -iE "X-Api-Key:.*$VERBOSE_SECRET" >/dev/null 2>&1; then
  test_fail "X-Api-Key header with secret found in verbose output!"
fi

test_pass

test_case "verbose command doesn't leak secrets"
# Run a command with verbose mode
run_mcpc --verbose "$SESSION3" ping
assert_success

ALL_OUTPUT="$STDOUT$STDERR"

# Check that secret is NOT in verbose output
if echo "$ALL_OUTPUT" | grep -q "$VERBOSE_SECRET"; then
  test_fail "Secret header value found in verbose command output!"
fi

# X-Api-Key header with secret should not appear
if echo "$ALL_OUTPUT" | grep -iE "X-Api-Key:.*$VERBOSE_SECRET" >/dev/null 2>&1; then
  test_fail "X-Api-Key header with secret found in verbose output!"
fi

test_pass

test_case "bridge log doesn't leak secrets"
# Check the bridge log file
BRIDGE_LOG="$MCPC_HOME_DIR/logs/bridge-$SESSION3.log"

if [[ -f "$BRIDGE_LOG" ]]; then
  LOG_CONTENT=$(cat "$BRIDGE_LOG")

  # Check that secret is NOT in bridge log
  if echo "$LOG_CONTENT" | grep -q "$VERBOSE_SECRET"; then
    test_fail "Secret header value found in bridge log!"
  fi

  # X-Api-Key header with secret should not appear
  if echo "$LOG_CONTENT" | grep -iE "X-Api-Key:.*$VERBOSE_SECRET" >/dev/null 2>&1; then
    test_fail "X-Api-Key header with secret found in bridge log!"
  fi
fi

test_pass

# Clean up verbose test session
run_mcpc "$SESSION3" close >/dev/null 2>&1
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION3}")

# =============================================================================
# Test: Headers work after bridge restart (retrieved from keychain)
# =============================================================================

test_case "headers persist through bridge restart"
# Get the bridge PID
bridge_pid=$(run_mcpc --json | jq -r ".sessions[] | select(.name == \"$SESSION\") | .pid")

if [[ -n "$bridge_pid" && "$bridge_pid" != "null" ]]; then
  # Kill the bridge
  kill "$bridge_pid" 2>/dev/null || true
  sleep 1

  # Session should auto-restart and headers should still work
  # (headers are retrieved from keychain on restart)
  run_mcpc "$SESSION" ping
  assert_success
fi

test_pass

# Cleanup
test_case "cleanup: close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
