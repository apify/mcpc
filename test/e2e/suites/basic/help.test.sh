#!/bin/bash
# Test: CLI help and version commands

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/help"

# Test: --help shows usage
test_case "--help shows usage"
run_mcpc --help
assert_success
assert_contains "$STDOUT" "Usage:"
assert_contains "$STDOUT" "mcpc"
test_pass

# Test: -h is alias for --help
test_case "-h is alias for --help"
run_mcpc -h
assert_success
assert_contains "$STDOUT" "Usage:"
test_pass

# Test: bare mcpc shows usage hint
test_case "bare mcpc shows usage hint"
run_mcpc
assert_success
assert_contains "$STDOUT" "--help"
test_pass

# Test: --version shows version
test_case "--version shows version"
run_mcpc --version
assert_success
# Should match semver pattern
if [[ ! "$STDOUT" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  test_fail "version should be semver format, got: $STDOUT"
  exit 1
fi
test_pass

# Test: version matches package.json
test_case "version matches package.json"
run_mcpc --version
pkg_version=$(node -p "require('$PROJECT_ROOT/package.json').version")
assert_eq "$STDOUT" "$pkg_version" "version should match package.json"
test_pass

test_done
