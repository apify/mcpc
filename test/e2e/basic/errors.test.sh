#!/bin/bash
# Test: Error handling for invalid inputs

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/common.sh"

setup_test
trap cleanup_test EXIT

# Test 1: Invalid session name (missing @)
begin_test "invalid session name - missing @"
run_mcpc invalid-session tools-list
assert_failure $EXIT_CODE
pass

# Test 2: Invalid session name (special characters)
begin_test "invalid session name - special characters"
run_mcpc "@test/invalid" tools-list
assert_failure $EXIT_CODE
pass

# Test 3: Non-existent session
begin_test "non-existent session"
run_mcpc @nonexistent-session-xyz tools-list
assert_failure $EXIT_CODE
assert_contains "$STDERR" "not found"
pass

# Test 4: Invalid command
begin_test "invalid command"
run_mcpc @test invalid-command
assert_failure $EXIT_CODE
pass

# Test 5: Missing required argument for session command
begin_test "missing required argument for session"
run_mcpc example.com session
assert_failure $EXIT_CODE
assert_contains "$STDERR" "name"
pass

# Test 6: Invalid URL scheme
begin_test "invalid URL scheme"
run_mcpc "ftp://example.com" tools-list
assert_failure $EXIT_CODE
pass

# Test 7: Empty target
begin_test "empty target shows help"
run_mcpc ""
# Empty string should be treated as no target
assert_success $EXIT_CODE
pass

print_summary
