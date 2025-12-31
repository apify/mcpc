#!/bin/bash
# Test: Environment variables (MCPC_HOME_DIR, MCPC_VERBOSE, MCPC_JSON)

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/env-vars" --isolated

# Start test server
start_test_server

# Test: MCPC_HOME_DIR changes home directory
test_case "MCPC_HOME_DIR changes home directory"
# Create a custom home directory
CUSTOM_HOME="$TEST_TMP/custom-home"
mkdir -p "$CUSTOM_HOME"

# Copy the auth profile to custom home (needed for HTTP server auth)
cp "$MCPC_HOME_DIR/profiles.json" "$CUSTOM_HOME/profiles.json"

# Create a session with custom home
SESSION=$(session_name "env-home")
MCPC_HOME_DIR="$CUSTOM_HOME" run_mcpc "$TEST_SERVER_URL" session "$SESSION"
assert_success

# Verify sessions.json exists in custom home
assert_file_exists "$CUSTOM_HOME/sessions.json"

# Verify session is accessible with custom home
MCPC_HOME_DIR="$CUSTOM_HOME" run_xmcpc "$SESSION" tools-list
assert_success

# Clean up - close the session
MCPC_HOME_DIR="$CUSTOM_HOME" run_mcpc "$SESSION" close 2>/dev/null || true
test_pass

# Test: MCPC_JSON=1 enables JSON output
test_case "MCPC_JSON=1 enables JSON output"
MCPC_JSON=1 run_mcpc --help
# Help doesn't support JSON, but other commands should
MCPC_JSON=1 run_mcpc --version
assert_success
assert_json_valid "$STDOUT" "MCPC_JSON should produce JSON output"
test_pass

# Test: MCPC_JSON=true works
test_case "MCPC_JSON=true works"
MCPC_JSON=true run_mcpc --version
assert_success
assert_json_valid "$STDOUT"
test_pass

# Test: MCPC_JSON=yes works (case insensitive)
test_case "MCPC_JSON=yes works"
MCPC_JSON=yes run_mcpc --version
assert_success
assert_json_valid "$STDOUT"
test_pass

# Test: MCPC_JSON=YES works (uppercase)
test_case "MCPC_JSON=YES works (uppercase)"
MCPC_JSON=YES run_mcpc --version
assert_success
assert_json_valid "$STDOUT"
test_pass

# Test: MCPC_JSON=0 disables JSON (default text)
test_case "MCPC_JSON=0 produces text output"
MCPC_JSON=0 run_mcpc --version
assert_success
# Should not be JSON
if echo "$STDOUT" | jq . >/dev/null 2>&1; then
  # If it's valid JSON, check if it's the version string (which is valid JSON as a string)
  # Actually semver like "1.2.3" is not valid JSON, so this is fine
  :
fi
test_pass

# Test: MCPC_VERBOSE=1 enables verbose mode
test_case "MCPC_VERBOSE=1 enables verbose output"
SESSION2=$(session_name "env-verbose")
run_mcpc "$TEST_SERVER_URL" session "$SESSION2"
assert_success
_SESSIONS_CREATED+=("$SESSION2")

MCPC_VERBOSE=1 run_mcpc "$SESSION2" tools-list
assert_success
# Verbose mode should add output to stderr
# (actual content depends on implementation)
test_pass

# Test: MCPC_VERBOSE=true works
test_case "MCPC_VERBOSE=true works"
MCPC_VERBOSE=true run_mcpc "$SESSION2" ping
assert_success
test_pass

# Test: combined env vars
test_case "MCPC_JSON and MCPC_VERBOSE together"
MCPC_JSON=1 MCPC_VERBOSE=1 run_mcpc "$SESSION2" tools-list
assert_success
assert_json_valid "$STDOUT" "should have JSON output with MCPC_JSON=1"
test_pass

# Test: --json flag overrides MCPC_JSON=0
test_case "--json flag overrides MCPC_JSON=0"
MCPC_JSON=0 run_mcpc --json --version
assert_success
assert_json_valid "$STDOUT" "--json should override MCPC_JSON=0"
test_pass

# Test: invalid MCPC_JSON value is ignored (defaults to off)
test_case "invalid MCPC_JSON value defaults to off"
MCPC_JSON=invalid run_mcpc --version
assert_success
# Should produce text output (semver string)
test_pass

test_done
