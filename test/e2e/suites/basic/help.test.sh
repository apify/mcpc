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

# Test: mcpc --skill is an undocumented alias printing the exact same guide.
# Kept out of --help output on purpose (one documented way to print the guide),
# but agents reach for the bare flag, so it must not be a dead end.
test_case "--skill matches help --skill"
run_mcpc --skill
assert_success
SKILL_FLAG_OUTPUT="$STDOUT"
assert_contains "$SKILL_FLAG_OUTPUT" "name: mcpc"
run_mcpc help --skill
assert_success
assert_eq "$SKILL_FLAG_OUTPUT" "$STDOUT" "mcpc --skill should match mcpc help --skill"
test_pass

# Test: the top-level --skill alias stays out of the documented options
test_case "--skill is not listed as a top-level option"
run_mcpc --help
assert_success
assert_not_contains "$STDOUT" "Print the agent skill"
assert_contains "$STDOUT" "mcpc help --skill"
test_pass

# Test: --skill with a command is not silently treated as the guide
test_case "--skill with a command name errors"
run_mcpc --skill connect
assert_failure
assert_not_contains "$STDOUT" "Mental model"
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

# Test: mcpc help accepts raw MCP method names, like the command slot itself does
test_case "help resolves slash-style method names"
run_mcpc help server/discover
assert_success
assert_contains "$STDOUT" "mcpc <@session> server-discover"
run_mcpc help tools/list
assert_success
assert_contains "$STDOUT" "mcpc <@session> tools-list"
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

# =============================================================================
# Help formatting invariants (cover the whole help surface)
# =============================================================================

# Print the continuation lines Commander emits when a description is too long to
# fit next to its term: inside an Options:/Commands: block they start way past the
# term column instead of at column 3.
_wrapped_help_lines() {
  awk '
    /^(Options|Commands):/ { inblock = 1; next }
    /^[^ ]/ { inblock = 0 }
    inblock && (match($0, /[^ ]/) - 1) >= 12 { print }
  '
}

# Collect the session subcommands from the help screen itself, so commands added
# later are covered without touching this test.
run_mcpc @test-session --help
SESSION_COMMANDS=$(printf '%s\n' "$STDOUT" | awk '
  /^Commands:/ { inblock = 1; next }
  /^[^ ]/ { inblock = 0 }
  inblock && match($0, /[^ ]/) == 3 { print $1 }
')

# Every description must fit on one line — a wrapped one turns the command list
# into a wall of text for humans and agents alike. Details belong in help sections.
test_case "no help screen wraps an option or command description"
WRAPPED=""
for screen in "--help" "help connect" "help login" "help logout" "help clean" "help grep" \
  "help close" "help restart" "help x402" "x402 sign --help" "@test-session --help"; do
  # shellcheck disable=SC2086
  run_mcpc $screen
  found=$(printf '%s\n' "$STDOUT" | _wrapped_help_lines)
  [[ -n "$found" ]] && WRAPPED+="mcpc $screen:"$'\n'"$found"$'\n'
done
for cmd in $SESSION_COMMANDS; do
  run_mcpc @test-session "$cmd" --help
  found=$(printf '%s\n' "$STDOUT" | _wrapped_help_lines)
  [[ -n "$found" ]] && WRAPPED+="mcpc @test-session $cmd --help:"$'\n'"$found"$'\n'
done
if [[ -n "$WRAPPED" ]]; then
  test_fail "wrapped help descriptions (shorten them, move details to addHelpText):"$'\n'"$WRAPPED"
  exit 1
fi
test_pass

# Agents discover the machine-readable shape from --help, so every session command
# must document its --json output.
test_case "every session command documents its JSON output"
MISSING=""
for cmd in $SESSION_COMMANDS; do
  run_mcpc @test-session "$cmd" --help
  assert_success
  if ! printf '%s\n' "$STDOUT" | grep -q "JSON output (--json):"; then
    MISSING+=" $cmd"
  fi
done
if [[ -n "$MISSING" ]]; then
  test_fail "session commands without a JSON output section (add jsonHelp()):$MISSING"
  exit 1
fi
test_pass

test_done
