#!/bin/bash
# End-to-end (E2E) testing framework for mcpc
#
# Features:
# - Shared home directory by default (tests file locking and concurrency)
# - Optional isolated home directory (--isolated flag)
# - Parallel execution support with unique session names
# - Two commands: mcpc (direct) and xmcpc (with invariant checks)
# - Automatic keychain cleanup
# - Structured logging
#
# Usage in test files:
#   source "$(dirname "$0")/../../lib/framework.sh"
#   test_init "my-test-name"              # Uses shared home directory
#   test_init "my-test-name" --isolated   # Uses isolated home directory
#
#   test_case "description"
#   run_mcpc @session tools-list
#   assert_success
#   assert_contains "$STDOUT" "expected text"
#   test_pass
#
#   test_done
#
# Environment variables:
#   E2E_ISOLATED_ALL=1  - Force all tests to use isolated home (for troubleshooting)

set -euo pipefail

# ============================================================================
# Configuration
# ============================================================================

# Get script locations
_FRAMEWORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PROJECT_ROOT="$(cd "$_FRAMEWORK_DIR/../../.." && pwd)"

# Generate unique run ID (shared across all tests in this run)
export E2E_RUN_ID="${E2E_RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}"

# Base directory for all test runs
export E2E_RUNS_DIR="${E2E_RUNS_DIR:-$PROJECT_ROOT/test/runs}"

# Force all tests to use isolated home directories (for troubleshooting)
E2E_ISOLATED_ALL="${E2E_ISOLATED_ALL:-0}"

# Shared home directory for this test run (set by run.sh)
# Falls back to run directory if not set
E2E_SHARED_HOME="${E2E_SHARED_HOME:-$E2E_RUNS_DIR/$E2E_RUN_ID/_shared_home}"

# Colors
_RED='\033[0;31m'
_GREEN='\033[0;32m'
_YELLOW='\033[0;33m'
_BLUE='\033[0;34m'
_DIM='\033[0;2m'
_NC='\033[0m'

# Test state
_TEST_NAME=""
_TEST_RUN_DIR=""
_TEST_CASES_RUN=0
_TEST_CASES_PASSED=0
_TEST_CASES_FAILED=0
_CURRENT_CASE=""
_TEST_ISOLATED=0  # Whether this test uses isolated home directory
_TEST_ISOLATED_HOME=""  # Path to isolated home dir (for cleanup)
declare -a _SESSIONS_CREATED=()  # Explicit array declaration

# ============================================================================
# Test Initialization
# ============================================================================

# Initialize test environment
# Usage: test_init "test-name" [--isolated]
# Options:
#   --isolated  Use isolated home directory (for tests that manipulate files directly)
test_init() {
  _TEST_NAME="$1"
  shift

  # Parse options
  _TEST_ISOLATED=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --isolated)
        _TEST_ISOLATED=1
        shift
        ;;
      *)
        echo "Unknown option to test_init: $1" >&2
        exit 1
        ;;
    esac
  done

  # Force isolated mode if E2E_ISOLATED_ALL is set
  if [[ "$E2E_ISOLATED_ALL" == "1" || "$E2E_ISOLATED_ALL" == "true" ]]; then
    _TEST_ISOLATED=1
  fi

  # Create unique run directory for this test (for logs and artifacts)
  _TEST_RUN_DIR="$E2E_RUNS_DIR/$E2E_RUN_ID/$_TEST_NAME"
  mkdir -p "$_TEST_RUN_DIR"

  # Generate short unique ID for this test (used in session names)
  # This keeps Unix socket paths under the 104 char limit
  _TEST_SHORT_ID="$(echo "$E2E_RUN_ID-$_TEST_NAME" | md5sum 2>/dev/null | cut -c1-8 || md5 -q -s "$E2E_RUN_ID-$_TEST_NAME" | cut -c1-8)"

  # Set up mcpc home directory
  # Use /tmp to keep socket paths short (Unix sockets limited to ~104 bytes)
  if [[ $_TEST_ISOLATED -eq 1 ]]; then
    # Isolated: each test gets its own home directory
    export MCPC_HOME_DIR="/tmp/mcpc-e2e-$_TEST_SHORT_ID"
    _TEST_ISOLATED_HOME="$MCPC_HOME_DIR"  # Track for cleanup
  else
    # Shared: all tests in this run share the same home directory
    export MCPC_HOME_DIR="$E2E_SHARED_HOME"
  fi
  mkdir -p "$MCPC_HOME_DIR"

  # Create temp directory for test artifacts
  export TEST_TMP="$_TEST_RUN_DIR/tmp"
  mkdir -p "$TEST_TMP"

  # Set up cleanup trap
  trap '_test_cleanup' EXIT

  # Log test start
  local home_mode="shared"
  [[ $_TEST_ISOLATED -eq 1 ]] && home_mode="isolated"
  echo "# Test: $_TEST_NAME"
  echo "# Run dir: $_TEST_RUN_DIR"
  echo "# Home dir: $MCPC_HOME_DIR ($home_mode)"
  echo ""
}

# Internal cleanup function
_test_cleanup() {
  local exit_code=$?

  # Close any sessions we created
  if [[ ${#_SESSIONS_CREATED[@]} -gt 0 ]]; then
    for session in "${_SESSIONS_CREATED[@]}"; do
      [[ -n "$session" ]] && $MCPC "$session" close 2>/dev/null || true
    done
  fi

  # Clean up keychain entries for our sessions
  _cleanup_keychain

  # Clean up isolated home directory (it's in /tmp)
  if [[ -n "${_TEST_ISOLATED_HOME:-}" && -d "$_TEST_ISOLATED_HOME" ]]; then
    rm -rf "$_TEST_ISOLATED_HOME"
  fi

  return $exit_code
}

# Clean up keychain entries created by tests
_cleanup_keychain() {
  # The keychain entries are keyed by server URL and profile name
  # Our test sessions use unique names, so entries should be unique
  # For now, we rely on sessions being closed properly
  # TODO: Add explicit keychain cleanup using `security delete-generic-password` on macOS
  :
}

# ============================================================================
# mcpc Command Wrappers
# ============================================================================

# Path to mcpc
MCPC="node $PROJECT_ROOT/dist/cli/index.js"

# Run mcpc and capture output
# Sets: STDOUT, STDERR, EXIT_CODE
# Note: Automatically adds --header for test server connections to satisfy auth requirement
run_mcpc() {
  local stdout_file="$TEST_TMP/stdout.$$.$RANDOM"
  local stderr_file="$TEST_TMP/stderr.$$.$RANDOM"

  # Build command args, adding test header if connecting to test server
  local -a args=()
  local first_arg="${1:-}"
  if [[ -n "${TEST_SERVER_URL:-}" && "$first_arg" == "$TEST_SERVER_URL" ]]; then
    # Add dummy header to satisfy auth credential requirement
    args=("$first_arg" "--header" "X-Test: true")
    shift
    for arg in "$@"; do
      args+=("$arg")
    done
  else
    args=("$@")
  fi

  set +e
  $MCPC ${args[@]+"${args[@]}"} >"$stdout_file" 2>"$stderr_file"
  EXIT_CODE=$?
  set -e

  STDOUT=$(cat "$stdout_file")
  STDERR=$(cat "$stderr_file")

  # Log to test log file
  {
    echo "=== run_mcpc $* ==="
    echo "Exit code: $EXIT_CODE"
    echo "--- stdout ---"
    cat "$stdout_file"
    echo "--- stderr ---"
    cat "$stderr_file"
    echo "=== end ==="
    echo ""
  } >> "$_TEST_RUN_DIR/commands.log"

  rm -f "$stdout_file" "$stderr_file"
}

# Run mcpc with extended invariant checks (xmcpc)
# Checks:
# 1. --verbose only adds to stderr, not stdout (for both bare and --json)
# 2. --json on success: valid JSON to stdout, nothing to stderr
# 3. --json on error: valid JSON to stderr, nothing to stdout
#
# Runs the caller's exact command and returns those results.
# Additionally runs all 4 combinations of --json/--verbose to verify invariants.
run_xmcpc() {
  # Run caller's exact command first
  run_mcpc "$@"
  local caller_stdout="$STDOUT"
  local caller_stderr="$STDERR"
  local caller_exit="$EXIT_CODE"

  # Strip --json and --verbose from args to get bare args
  local bare_args=()
  for arg in "$@"; do
    case "$arg" in
      --json|-j|--verbose|-v) ;;
      *) bare_args+=("$arg") ;;
    esac
  done

  # Run all 4 variants for invariant checking
  # Use ${bare_args[@]+"${bare_args[@]}"} to handle empty array with nounset
  run_mcpc ${bare_args[@]+"${bare_args[@]}"}
  local bare_stdout="$STDOUT"

  run_mcpc --verbose ${bare_args[@]+"${bare_args[@]}"}
  local verbose_stdout="$STDOUT"

  run_mcpc --json ${bare_args[@]+"${bare_args[@]}"}
  local json_stdout="$STDOUT"
  local json_stderr="$STDERR"
  local json_exit="$EXIT_CODE"

  run_mcpc --json --verbose ${bare_args[@]+"${bare_args[@]}"}
  local json_verbose_stdout="$STDOUT"
  local json_verbose_stderr="$STDERR"

  # Check --verbose invariant: stdout should be identical with or without --verbose
  if [[ "$verbose_stdout" != "$bare_stdout" ]]; then
    echo "INVARIANT VIOLATION: --verbose changed stdout" >&2
    echo "--- bare stdout ---" >&2
    echo "$bare_stdout" >&2
    echo "--- verbose stdout ---" >&2
    echo "$verbose_stdout" >&2
    EXIT_CODE=99
    return 1
  fi

  if [[ "$json_verbose_stdout" != "$json_stdout" ]]; then
    echo "INVARIANT VIOLATION: --verbose changed stdout (with --json)" >&2
    echo "--- json stdout ---" >&2
    echo "$json_stdout" >&2
    echo "--- json verbose stdout ---" >&2
    echo "$json_verbose_stdout" >&2
    EXIT_CODE=99
    return 1
  fi

  # Check --json invariants
  if [[ $json_exit -eq 0 ]]; then
    # On success: valid JSON to stdout, stderr should be empty
    if ! echo "$json_stdout" | jq . >/dev/null 2>&1; then
      echo "INVARIANT VIOLATION: --json success did not return valid JSON to stdout" >&2
      echo "--- stdout ---" >&2
      echo "$json_stdout" >&2
      EXIT_CODE=99
      return 1
    fi
    if [[ -n "$json_stderr" ]]; then
      echo "INVARIANT VIOLATION: --json success should not output to stderr" >&2
      echo "--- stderr ---" >&2
      echo "$json_stderr" >&2
      EXIT_CODE=99
      return 1
    fi
  else
    # On error: valid JSON to stderr, stdout should be empty
    if ! echo "$json_stderr" | jq . >/dev/null 2>&1; then
      echo "INVARIANT VIOLATION: --json error did not return valid JSON to stderr" >&2
      echo "--- stderr ---" >&2
      echo "$json_stderr" >&2
      EXIT_CODE=99
      return 1
    fi
    if [[ -n "$json_stdout" ]]; then
      echo "INVARIANT VIOLATION: --json error should not output to stdout" >&2
      echo "--- stdout ---" >&2
      echo "$json_stdout" >&2
      EXIT_CODE=99
      return 1
    fi
  fi

  # Return caller's exact results
  STDOUT="$caller_stdout"
  STDERR="$caller_stderr"
  EXIT_CODE="$caller_exit"
}

# ============================================================================
# Session Helpers
# ============================================================================

# Generate unique session name for this test
# Usage: session_name "suffix"
# Returns: @e-<short-id>-<suffix>
# Note: Uses short ID to keep socket paths under Unix 104 char limit
session_name() {
  local suffix="${1:-s}"
  echo "@e-${_TEST_SHORT_ID}-${suffix}"
}

# Create a session and track it for cleanup
# Usage: create_session <target> [session-suffix]
create_session() {
  local target="$1"
  local suffix="${2:-default}"
  local session=$(session_name "$suffix")

  run_mcpc "$target" session "$session"
  if [[ $EXIT_CODE -eq 0 ]]; then
    _SESSIONS_CREATED+=("$session")
  fi

  echo "$session"
}

# ============================================================================
# Test Case Management
# ============================================================================

# Start a test case
test_case() {
  _CURRENT_CASE="$1"
  ((_TEST_CASES_RUN++)) || true
}

# Mark current test case as passed
test_pass() {
  echo -e "${_GREEN}ok${_NC} $_TEST_CASES_RUN - $_CURRENT_CASE"
  ((_TEST_CASES_PASSED++)) || true
}

# Mark current test case as failed
test_fail() {
  local detail="${1:-}"
  echo -e "${_RED}not ok${_NC} $_TEST_CASES_RUN - $_CURRENT_CASE"
  if [[ -n "$detail" ]]; then
    echo "# $detail"
  fi
  ((_TEST_CASES_FAILED++)) || true
}

# Skip a test case
test_skip() {
  local reason="${1:-}"
  echo -e "${_YELLOW}ok${_NC} $_TEST_CASES_RUN - $_CURRENT_CASE # SKIP${reason:+ $reason}"
  ((_TEST_CASES_PASSED++)) || true
}

# Print test summary and exit with appropriate code
test_done() {
  echo ""
  echo "# Tests: $_TEST_CASES_RUN, Passed: $_TEST_CASES_PASSED, Failed: $_TEST_CASES_FAILED"

  if [[ $_TEST_CASES_FAILED -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

# ============================================================================
# Assertions
# ============================================================================

assert_success() {
  local msg="${1:-command should succeed}"
  if [[ $EXIT_CODE -ne 0 ]]; then
    test_fail "$msg (exit code: $EXIT_CODE)"
    echo "# stdout: $STDOUT"
    echo "# stderr: $STDERR"
    exit 1
  fi
}

assert_failure() {
  local msg="${1:-command should fail}"
  if [[ $EXIT_CODE -eq 0 ]]; then
    test_fail "$msg (expected non-zero exit code)"
    exit 1
  fi
}

assert_exit_code() {
  local expected="$1"
  local msg="${2:-exit code should be $expected}"
  if [[ $EXIT_CODE -ne $expected ]]; then
    test_fail "$msg (got: $EXIT_CODE)"
    exit 1
  fi
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local msg="${3:-should contain '$needle'}"
  if [[ "$haystack" != *"$needle"* ]]; then
    test_fail "$msg"
    echo "# Got: ${haystack:0:200}..."
    exit 1
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local msg="${3:-should not contain '$needle'}"
  if [[ "$haystack" == *"$needle"* ]]; then
    test_fail "$msg"
    exit 1
  fi
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local msg="${3:-values should be equal}"
  if [[ "$actual" != "$expected" ]]; then
    test_fail "$msg"
    echo "# Expected: $expected"
    echo "# Got: $actual"
    exit 1
  fi
}

assert_not_empty() {
  local value="$1"
  local msg="${2:-value should not be empty}"
  if [[ -z "$value" ]]; then
    test_fail "$msg"
    exit 1
  fi
}

assert_empty() {
  local value="$1"
  local msg="${2:-value should be empty}"
  if [[ -n "$value" ]]; then
    test_fail "$msg"
    echo "# Got: $value"
    exit 1
  fi
}

assert_json_valid() {
  local json="$1"
  local msg="${2:-should be valid JSON}"
  if ! echo "$json" | jq . >/dev/null 2>&1; then
    test_fail "$msg"
    echo "# Got: ${json:0:200}..."
    exit 1
  fi
}

assert_json() {
  local json="$1"
  local expr="$2"
  local msg="${3:-JSON should match '$expr'}"
  if ! echo "$json" | jq -e "$expr" >/dev/null 2>&1; then
    test_fail "$msg"
    exit 1
  fi
}

assert_json_eq() {
  local json="$1"
  local field="$2"
  local expected="$3"
  local msg="${4:-$field should equal '$expected'}"

  local actual
  actual=$(echo "$json" | jq -r "$field" 2>/dev/null) || {
    test_fail "Failed to extract $field from JSON"
    exit 1
  }

  if [[ "$actual" != "$expected" ]]; then
    test_fail "$msg"
    echo "# Expected: $expected"
    echo "# Got: $actual"
    exit 1
  fi
}

assert_file_exists() {
  local path="$1"
  local msg="${2:-file should exist: $path}"
  if [[ ! -f "$path" ]]; then
    test_fail "$msg"
    exit 1
  fi
}

assert_file_not_exists() {
  local path="$1"
  local msg="${2:-file should not exist: $path}"
  if [[ -f "$path" ]]; then
    test_fail "$msg"
    exit 1
  fi
}

assert_stdout_empty() {
  assert_empty "$STDOUT" "stdout should be empty"
}

assert_stderr_empty() {
  assert_empty "$STDERR" "stderr should be empty"
}

# ============================================================================
# Test Server Helpers
# ============================================================================

# Default test server port
TEST_SERVER_PORT="${TEST_SERVER_PORT:-0}"  # 0 = random port
_TEST_SERVER_PID=""

# Start test MCP server
# Usage: start_test_server [env_vars...]
# Example: start_test_server PAGINATION_SIZE=2 LATENCY_MS=100
start_test_server() {
  # Find a free port if not specified
  if [[ "$TEST_SERVER_PORT" == "0" ]]; then
    TEST_SERVER_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')
  fi

  # Build environment
  local env_str="PORT=$TEST_SERVER_PORT"
  for var in "$@"; do
    env_str+=" $var"
  done

  # Start server
  cd "$PROJECT_ROOT"
  env $env_str npx tsx test/e2e/server/index.ts >"$_TEST_RUN_DIR/server.log" 2>&1 &
  _TEST_SERVER_PID=$!

  # Wait for server to be ready
  local max_wait=50  # 10 seconds
  local waited=0
  while ! curl -s "http://localhost:$TEST_SERVER_PORT/health" >/dev/null 2>&1; do
    sleep 0.2
    ((waited++)) || true
    if [[ $waited -ge $max_wait ]]; then
      echo "Error: Test server failed to start" >&2
      cat "$_TEST_RUN_DIR/server.log" >&2
      kill $_TEST_SERVER_PID 2>/dev/null || true
      exit 1
    fi
  done

  export TEST_SERVER_URL="http://localhost:$TEST_SERVER_PORT"
  echo "# Test server started at $TEST_SERVER_URL (PID: $_TEST_SERVER_PID)"

  # Create a dummy auth profile for the test server
  # mcpc requires auth profiles for HTTP servers, so we create a minimal one
  _create_test_auth_profile "localhost:$TEST_SERVER_PORT"
}

# Create a dummy auth profile for a host (internal helper)
# This is needed because mcpc requires auth profiles for all HTTP servers
# Uses atomic symlink creation for cross-platform locking
_create_test_auth_profile() {
  local host="$1"
  local profiles_file="$MCPC_HOME_DIR/profiles.json"
  local lock_file="$MCPC_HOME_DIR/profiles.lock"

  # Ensure mcpc home dir exists
  mkdir -p "$MCPC_HOME_DIR"

  # Acquire lock using atomic symlink (works on macOS and Linux)
  local max_wait=50
  local waited=0
  while ! ln -s $$ "$lock_file" 2>/dev/null; do
    sleep 0.1
    ((waited++)) || true
    if [[ $waited -ge $max_wait ]]; then
      # Stale lock - remove and retry
      rm -f "$lock_file"
      waited=0
    fi
  done

  # Ensure lock is released on function exit
  trap 'rm -f "$lock_file"' RETURN

  # Create or update profiles.json with a dummy profile for this host
  if [[ -f "$profiles_file" && -s "$profiles_file" ]]; then
    # File exists and is non-empty - add profile for this host using jq
    local updated
    if updated=$(jq --arg host "$host" '.profiles[$host] = {"default": {"name": "default", "serverUrl": ("http://" + $host), "authType": "oauth", "oauthIssuer": "https://test.example.com", "createdAt": "2025-01-01T00:00:00Z"}}' "$profiles_file" 2>/dev/null); then
      # Write to temp file then atomically rename
      local temp_file="$profiles_file.$$.tmp"
      echo "$updated" > "$temp_file"
      mv "$temp_file" "$profiles_file"
    else
      # JSON parse error - recreate file
      cat > "$profiles_file" << EOF
{
  "profiles": {
    "$host": {
      "default": {
        "name": "default",
        "serverUrl": "http://$host",
        "authType": "oauth",
        "oauthIssuer": "https://test.example.com",
        "createdAt": "2025-01-01T00:00:00Z"
      }
    }
  }
}
EOF
    fi
  else
    # Create new profiles file
    cat > "$profiles_file" << EOF
{
  "profiles": {
    "$host": {
      "default": {
        "name": "default",
        "serverUrl": "http://$host",
        "authType": "oauth",
        "oauthIssuer": "https://test.example.com",
        "createdAt": "2025-01-01T00:00:00Z"
      }
    }
  }
}
EOF
  fi
}

# Stop test server
stop_test_server() {
  if [[ -n "$_TEST_SERVER_PID" ]]; then
    # Kill all child processes first (tsx spawns node as child)
    pkill -P "$_TEST_SERVER_PID" 2>/dev/null || true
    # Then kill the parent process
    kill "$_TEST_SERVER_PID" 2>/dev/null || true
    wait "$_TEST_SERVER_PID" 2>/dev/null || true
    _TEST_SERVER_PID=""
  fi
}

# Server control: fail next N requests
server_fail_next() {
  local count="${1:-1}"
  curl -s -X POST "$TEST_SERVER_URL/control/fail-next?count=$count" >/dev/null
}

# Server control: expire session
server_expire_session() {
  curl -s -X POST "$TEST_SERVER_URL/control/expire-session" >/dev/null
}

# Server control: reset state
server_reset() {
  curl -s -X POST "$TEST_SERVER_URL/control/reset" >/dev/null
}

# Add server cleanup to trap
_original_cleanup=$(trap -p EXIT | sed "s/trap -- '\(.*\)' EXIT/\1/")
trap 'stop_test_server; '"$_original_cleanup" EXIT

# ============================================================================
# Stdio Server Helpers
# ============================================================================

# Create a config file for stdio server
# Usage: create_stdio_config <name> <command> [args...]
# Returns: path to config file
create_stdio_config() {
  local name="$1"
  local command="$2"
  shift 2
  local args=("$@")

  local config_file="$TEST_TMP/config-$name.json"
  local args_json=$(printf '%s\n' "${args[@]}" | jq -R . | jq -s .)

  cat > "$config_file" <<EOF
{
  "mcpServers": {
    "$name": {
      "command": "$command",
      "args": $args_json
    }
  }
}
EOF

  echo "$config_file"
}

# Create config for filesystem server
# Usage: create_fs_config [path]
create_fs_config() {
  local path="${1:-$TEST_TMP}"
  create_stdio_config "fs" "npx" "-y" "@modelcontextprotocol/server-filesystem" "$path"
}

# ============================================================================
# Utility Functions
# ============================================================================

# Wait for condition with timeout
# Usage: wait_for <command> [timeout_seconds]
wait_for() {
  local cmd="$1"
  local timeout="${2:-10}"
  local interval=0.2
  local elapsed=0

  while ! eval "$cmd" 2>/dev/null; do
    sleep $interval
    elapsed=$(echo "$elapsed + $interval" | bc)
    if (( $(echo "$elapsed >= $timeout" | bc -l) )); then
      return 1
    fi
  done
  return 0
}

# Get JSON field from STDOUT
# Usage: json_get ".field.path"
json_get() {
  echo "$STDOUT" | jq -r "$1"
}

# Check if running on macOS
is_macos() {
  [[ "$(uname)" == "Darwin" ]]
}

# Check if running on Linux
is_linux() {
  [[ "$(uname)" == "Linux" ]]
}
