#!/bin/bash
# Test: completion-complete (MCP completion/complete)
#
# Argument suggestions for prompts and resource templates. The request and result
# shapes are identical in every protocol era, so this suite runs against both test
# servers; only the server's `completions` capability gates the command.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/completion"

start_test_server

SESSION=$(session_name "cmpl")

test_case "setup: create session"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

test_case "session overview lists completions and the command"
run_mcpc "$SESSION"
assert_success
assert_contains "$STDOUT" "completions"
assert_contains "$STDOUT" "mcpc $SESSION completion-complete prompt|resource <ref> <arg>"
test_pass

# =============================================================================
# Prompt arguments
# =============================================================================

test_case "prompt argument without a typed value lists every suggestion"
run_xmcpc "$SESSION" completion-complete prompt greeting style
assert_success
assert_contains "$STDOUT" "formal"
assert_contains "$STDOUT" "casual"
test_pass

test_case "human output hints at prompts-get with the first suggestion"
run_mcpc "$SESSION" completion-complete prompt greeting style
assert_success
assert_contains "$STDOUT" "mcpc $SESSION prompts-get greeting style:=formal"
test_pass

test_case "the typed value narrows the suggestions"
run_mcpc --json "$SESSION" completion-complete prompt greeting style style:=f
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '.completion.values == ["formal"]'
assert_json "$STDOUT" '.completion.total == 1'
assert_json "$STDOUT" '.completion.hasMore == false'
test_pass

test_case "--json prints the raw CompleteResult"
run_mcpc --json "$SESSION" completion-complete prompt greeting style
assert_success
assert_json "$STDOUT" '.completion.values == ["formal", "casual"]'
assert_not_contains "$STDOUT" "prompts-get"
test_pass

test_case "other arguments are sent as context (key:=value)"
run_mcpc --json "$SESSION" completion-complete prompt greeting name style:=formal
assert_success
assert_json "$STDOUT" '.completion.values == ["Sir Reginald", "Madam Beatrix"]'
test_pass

test_case "without context the server answers differently"
run_mcpc --json "$SESSION" completion-complete prompt greeting name
assert_success
assert_json "$STDOUT" '.completion.values == ["Alice", "Bob", "Charlie"]'
test_pass

test_case "inline JSON arguments work like key:=value pairs"
run_mcpc --json "$SESSION" completion-complete prompt greeting name '{"style":"formal","name":"Ma"}'
assert_success
assert_json "$STDOUT" '.completion.values == ["Madam Beatrix"]'
test_pass

test_case "stdin arguments work like key:=value pairs"
run_mcpc --json "$SESSION" completion-complete prompt greeting name < <(echo '{"style":"formal","name":"Sir"}')
assert_success
assert_json "$STDOUT" '.completion.values == ["Sir Reginald"]'
test_pass

test_case "a typed value with spaces survives the shell hint quoting"
run_mcpc "$SESSION" completion-complete prompt greeting name style:=formal
assert_success
assert_contains "$STDOUT" 'prompts-get greeting name:="Sir Reginald"'
test_pass

test_case "a capped result reports total and hasMore"
run_mcpc --json "$SESSION" completion-complete prompt summarize maxLength
assert_success
assert_json "$STDOUT" '.completion.values | length == 100'
assert_json "$STDOUT" '.completion.total == 150'
assert_json "$STDOUT" '.completion.hasMore == true'
run_mcpc "$SESSION" completion-complete prompt summarize maxLength
assert_success
assert_contains "$STDOUT" "Showing 100 of 150 suggestions, more available"
test_pass

test_case "non-string values are sent as text, like prompts-get does"
run_mcpc --json "$SESSION" completion-complete prompt summarize maxLength maxLength:=14
assert_success
assert_json "$STDOUT" '.completion.values == ["140", "1400", "1410", "1420", "1430", "1440", "1450", "1460", "1470", "1480", "1490"]'
test_pass

# =============================================================================
# Resource template variables
# =============================================================================

test_case "resource template variable lists suggestions"
run_mcpc --json "$SESSION" completion-complete resource 'test://file/{path}' path
assert_success
assert_json "$STDOUT" '.completion.values | length == 3'
test_pass

test_case "resource template hint expands the variable for resources-read"
run_mcpc "$SESSION" completion-complete resource 'test://file/{path}' path path:=docs/c
assert_success
assert_contains "$STDOUT" "docs/changelog.md"
assert_contains "$STDOUT" "mcpc $SESSION resources-read test://file/docs%2Fchangelog.md"
test_pass

test_case "no match prints an empty-state line"
run_mcpc "$SESSION" completion-complete prompt greeting style style:=zzz
assert_success
assert_contains "$STDOUT" "(no suggestions for style)"
test_pass

# =============================================================================
# Errors
# =============================================================================

test_case "unknown reference type is a client error naming both choices"
run_xmcpc "$SESSION" completion-complete tool greeting style
assert_exit_code 1
assert_contains "$STDERR" '"prompt"'
assert_contains "$STDERR" '"resource"'
test_pass

test_case "unknown prompt is a server error"
run_xmcpc "$SESSION" completion-complete prompt nonexistent style
assert_exit_code 2
assert_contains "$STDERR" "Failed to complete argument style of prompt nonexistent"
test_pass

test_case "the raw method name resolves to the command"
run_mcpc help completion/complete
assert_success
assert_contains "$STDOUT" "completion-complete"
assert_contains "$STDOUT" "JSON output (--json):"
test_pass

test_case "cleanup: close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
