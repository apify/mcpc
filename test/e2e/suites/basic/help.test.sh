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
assert_contains "$STDOUT" "mcpc help [--skill]"
test_pass

# Test: --help points AI agents at the guide
test_case "--help points agents at mcpc help --skill"
run_mcpc --help
assert_success
assert_contains "$STDOUT" "mcpc help --skill"
test_pass

# =============================================================================
# help --skill (agent skill)
# =============================================================================

# Test: mcpc help --skill prints the agent skill
test_case "help --skill prints the agent skill"
run_mcpc help --skill
assert_success
assert_contains "$STDOUT" "name: mcpc"
assert_contains "$STDOUT" "Mental model"
test_pass

# Test: mcpc help (no args) still shows the overview, not the guide
test_case "help with no args shows the command overview"
run_mcpc help
assert_success
assert_contains "$STDOUT" "Usage:"
assert_not_contains "$STDOUT" "Mental model"
test_pass

# Test: mcpc help --skill with a command name is rejected, not silently ignored
test_case "help --skill with a command name errors"
run_mcpc help --skill connect
assert_failure
assert_not_contains "$STDOUT" "Mental model"
assert_contains "$STDERR" "takes no command name"
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
_pkg_root="$(to_native_path "$PROJECT_ROOT")"
pkg_version=$(node -p "require('$_pkg_root/package.json').version")
assert_eq "$STDOUT" "$pkg_version" "version should match package.json"
test_pass

# Test: --version with --json returns JSON
test_case "--version --json returns JSON"
run_mcpc --version --json
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '.version'
test_pass

# Test: --version JSON matches text version
test_case "--version JSON matches text version"
run_mcpc --version
text_version="$STDOUT"
run_mcpc --version --json
json_version=$(echo "$STDOUT" | jq -r '.version')
assert_eq "$json_version" "$text_version" "JSON version should match text version"
test_pass

# =============================================================================
# Session help
# =============================================================================

# Test: mcpc @session --help lists available commands
test_case "@session --help lists available commands"
run_mcpc @test-session --help
assert_success
assert_contains "$STDOUT" "Commands:"
assert_contains "$STDOUT" "tools-list"
assert_contains "$STDOUT" "close"
assert_contains "$STDOUT" "grep"
test_pass

# Test: mcpc @session --help mentions no-command behavior
test_case "@session --help mentions no-command behavior"
run_mcpc @test-session --help
assert_success
assert_contains "$STDOUT" "server info"
test_pass

# Test: mcpc @session --help does not show [options] on simple commands
test_case "@session --help does not show [options] on simple commands"
run_mcpc @test-session --help
assert_success
# "ping" has no options, should appear without [options]
assert_not_contains "$STDOUT" "ping [options]"
# "close" has no options, should appear without [options]
assert_not_contains "$STDOUT" "close [options]"
test_pass

# Test: mcpc @session --help does not list "help" as a command (redundant)
test_case "@session --help does not list help command"
run_mcpc @test-session --help
assert_success
# "help" should not appear as a listed command (it's hidden)
assert_not_contains "$STDOUT" "  help "
test_pass

# Test: mcpc @session --help shows grep after restart
test_case "@session --help shows grep after restart"
run_mcpc @test-session --help
assert_success
# grep should appear before tools (i.e. near the top with session management commands)
grep_line=$(echo "$STDOUT" | grep -n "grep" | head -1 | cut -d: -f1)
tools_line=$(echo "$STDOUT" | grep -n "tools-list" | head -1 | cut -d: -f1)
if [[ "$grep_line" -gt "$tools_line" ]]; then
  test_fail "grep (line $grep_line) should appear before tools-list (line $tools_line)"
  exit 1
fi
test_pass

# Test: mcpc @session help shows same output as --help
test_case "@session help matches @session --help"
run_mcpc @test-session --help
HELP_OUTPUT="$STDOUT"
run_mcpc @test-session help
assert_success
assert_eq "$STDOUT" "$HELP_OUTPUT" "help and --help output should match"
test_pass

test_done
