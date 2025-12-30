#!/bin/bash
# Test: Error handling for invalid inputs

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/errors"

# Test: invalid session name (special characters)
test_case "invalid session name - special characters"
run_mcpc "@test/invalid" tools-list
assert_failure
test_pass

# Test: non-existent session
test_case "non-existent session"
run_mcpc @nonexistent-session-$RANDOM tools-list
assert_failure
assert_contains "$STDERR" "not found"
test_pass

# Test: invalid command
test_case "invalid command"
run_mcpc @test invalid-command-$RANDOM
assert_failure
test_pass

# Test: missing required argument for session command
test_case "missing required argument for session"
run_mcpc example.com session
assert_failure
test_pass

# Test: invalid URL scheme
test_case "invalid URL scheme"
run_mcpc "ftp://example.com" tools-list
assert_failure
test_pass

# Test: empty target shows help
test_case "empty target shows help"
run_mcpc ""
# Empty string should be treated as no target
assert_success
test_pass

# Test: --json errors have proper structure
test_case "--json errors have proper structure"
run_mcpc @nonexistent-$RANDOM tools-list --json
assert_failure
if [[ -n "$STDOUT" ]]; then
  assert_json_valid "$STDOUT"
  assert_json "$STDOUT" '.error'
fi
test_pass

test_done
