#!/bin/bash
# Test: Output invariants (--verbose, --json behavior)

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/output-invariants"

# Test: --verbose doesn't change stdout for --help
test_case "--verbose doesn't change stdout for --help"
run_mcpc --help
stdout_normal="$STDOUT"

run_mcpc --help --verbose
stdout_verbose="$STDOUT"

assert_eq "$stdout_normal" "$stdout_verbose" "--verbose should not change stdout"
test_pass

# Test: --verbose doesn't change stdout for session list
test_case "--verbose doesn't change stdout for session list"
run_mcpc
stdout_normal="$STDOUT"

run_mcpc --verbose
stdout_verbose="$STDOUT"

assert_eq "$stdout_normal" "$stdout_verbose" "--verbose should not change stdout"
test_pass

# Test: --json returns valid JSON for session list
test_case "--json returns valid JSON for session list"
run_mcpc --json
assert_success
assert_json_valid "$STDOUT"
test_pass

# Test: --json has expected structure
test_case "--json has expected structure"
run_mcpc --json
assert_json "$STDOUT" '.sessions'
assert_json "$STDOUT" '.profiles'
test_pass

# Test: -j is alias for --json
test_case "-j is alias for --json"
run_mcpc -j
assert_success
assert_json_valid "$STDOUT"
test_pass

# Test: --json on error returns JSON or nothing
test_case "--json on error returns JSON or nothing"
run_mcpc @nonexistent-session-$RANDOM tools-list --json
assert_failure
# If there's stdout, it should be valid JSON
if [[ -n "$STDOUT" ]]; then
  assert_json_valid "$STDOUT" "--json should return valid JSON even on error"
fi
test_pass

# Test: xmcpc invariant check works (use session list, not --help)
test_case "xmcpc validates invariants automatically"
run_xmcpc
assert_success
test_pass

test_done
