#!/bin/bash
# Test: --timeout flag causes requests to fail when server is too slow

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/timeout" --isolated

# Start test server
start_test_server

# =============================================================================
# Test: tools-call with --timeout shorter than server delay
# =============================================================================

SESSION=$(create_session "$TEST_SERVER_URL" "timeout-1")
_SESSIONS_CREATED+=("$SESSION")

test_case "tools-call times out when server is slower than --timeout"
run_mcpc "$SESSION" tools-call slow ms:=10000 --timeout 2
assert_failure
# The error may mention "timeout", "abort", or "session not found" depending on
# how the SDK handles the cancellation. The key assertion is that it fails.
assert_not_empty "$STDERR" "stderr should have an error message"
test_pass

# Close and recreate session since timeout may have disrupted bridge state
run_mcpc "$SESSION" close 2>/dev/null || true

# =============================================================================
# Test: tools-call succeeds when --timeout is generous enough
# =============================================================================

SESSION2=$(create_session "$TEST_SERVER_URL" "timeout-2")
_SESSIONS_CREATED+=("$SESSION2")

test_case "tools-call succeeds when --timeout is long enough"
run_mcpc "$SESSION2" tools-call slow ms:=500 --timeout 10
assert_success
assert_contains "$STDOUT" "Waited 500ms"
test_pass

# =============================================================================
# Test: tools-list with --timeout works (fast response, no timeout)
# =============================================================================

test_case "tools-list succeeds with short --timeout (fast server response)"
run_mcpc "$SESSION2" tools-list --timeout 10
assert_success
assert_contains "$STDOUT" "echo"
test_pass

# =============================================================================
# Test: ping with --timeout
# =============================================================================

test_case "ping succeeds with reasonable --timeout"
run_mcpc "$SESSION2" ping --timeout 10
assert_success
test_pass

# =============================================================================
# Test: --timeout with --json outputs valid JSON error
# =============================================================================

SESSION3=$(create_session "$TEST_SERVER_URL" "timeout-3")
_SESSIONS_CREATED+=("$SESSION3")

test_case "timeout error with --json outputs valid JSON to stderr"
run_mcpc "$SESSION3" --json tools-call slow ms:=10000 --timeout 2
assert_failure
assert_json_valid "$STDERR" "timeout error should be valid JSON in --json mode"
test_pass

test_done
