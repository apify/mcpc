#!/bin/bash
# Test: Bridge resilience to MCP errors
#
# This suite verifies that the bridge survives a variety of MCP-level errors
# (unknown tools, bad arguments, missing resources/prompts, server failures)
# without crashing. It deliberately uses run_mcpc (a single mcpc invocation per
# check) rather than run_xmcpc (which runs 4 extra --json/--verbose variants for
# output-invariant checking): the checks here repeat live-bridge session commands
# many times, and at ~5 process spawns each that made this the slowest e2e test —
# right at the per-test watchdog limit, and over it on Windows. The output-format
# invariants are not what this test is about and are covered by basic/output-invariants
# (the invariant machinery) and basic/errors / basic/auth-errors (the --json error path).

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/bridge-resilience" --isolated

# Start test server
start_test_server

# Generate unique session name
SESSION=$(session_name "resilience")

# Test: create session
test_case "create session"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

# Test: verify session works initially
test_case "session works initially"
run_mcpc "$SESSION" tools-list
assert_success
test_pass

# Test: calling non-existent tool doesn't kill bridge
test_case "calling non-existent tool doesn't kill bridge"
run_mcpc "$SESSION" tools-call nonexistent-tool-$RANDOM
assert_failure  # Should fail gracefully

# Session should still work
run_mcpc "$SESSION" tools-list
assert_success "session should still work after failed tool call"
test_pass

# Test: calling tool with invalid arguments doesn't kill bridge
test_case "invalid tool arguments doesn't kill bridge"
# The 'add' tool expects numbers, pass strings
run_mcpc "$SESSION" tools-call add '{"a":"not-a-number","b":"also-not"}'
# May or may not fail depending on server validation

# Session should still work
run_mcpc "$SESSION" tools-list
assert_success "session should still work after invalid args"
test_pass

# Test: reading non-existent resource doesn't kill bridge
test_case "reading non-existent resource doesn't kill bridge"
run_mcpc "$SESSION" resources-read "nonexistent://resource/$RANDOM"
assert_failure  # Should fail gracefully

# Session should still work
run_mcpc "$SESSION" tools-list
assert_success "session should still work after failed resource read"
test_pass

# Test: getting non-existent prompt doesn't kill bridge
test_case "getting non-existent prompt doesn't kill bridge"
run_mcpc "$SESSION" prompts-get "nonexistent-prompt-$RANDOM"
assert_failure  # Should fail gracefully

# Session should still work
run_mcpc "$SESSION" tools-list
assert_success "session should still work after failed prompt get"
test_pass

# Test: server-side failure doesn't kill bridge
test_case "server failure doesn't kill bridge"
# Use control endpoint to make next request fail
curl -s -X POST "$TEST_SERVER_URL/control/fail-next?count=1" >/dev/null

run_mcpc "$SESSION" tools-list
assert_failure  # This request should fail

# Reset server and verify session recovers
curl -s -X POST "$TEST_SERVER_URL/control/reset" >/dev/null
run_mcpc "$SESSION" tools-list
assert_success "session should recover after server failure"
test_pass

# Test: multiple consecutive failures don't kill bridge
test_case "multiple consecutive failures don't kill bridge"
curl -s -X POST "$TEST_SERVER_URL/control/fail-next?count=3" >/dev/null

# These should all fail
run_mcpc "$SESSION" tools-list
run_mcpc "$SESSION" resources-list
run_mcpc "$SESSION" prompts-list

# Reset and verify
curl -s -X POST "$TEST_SERVER_URL/control/reset" >/dev/null
run_mcpc "$SESSION" tools-list
assert_success "session should survive multiple failures"
test_pass

# Test: calling tool that intentionally fails doesn't kill bridge
test_case "tool that throws error doesn't kill bridge"
run_mcpc "$SESSION" tools-call fail '{"message":"intentional failure"}'
assert_failure  # Tool failure is expected

# Session should still work
run_mcpc "$SESSION" tools-list
assert_success "session should work after tool error"
test_pass

# Test: bridge PID unchanged after all errors
test_case "bridge PID unchanged after all errors"
run_mcpc --json
original_pid=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .pid")
assert_not_empty "$original_pid" "should have bridge PID"

# Cause a few more errors
run_mcpc "$SESSION" tools-call nonexistent 2>/dev/null || true
run_mcpc "$SESSION" resources-read "bad://uri" 2>/dev/null || true

# Check PID is still the same
run_mcpc --json
current_pid=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .pid")
assert_eq "$current_pid" "$original_pid" "bridge PID should not change after errors"
test_pass

test_done
