#!/bin/bash
# Test: Prompts operations (list, get)
# Tests prompts-list and prompts-get commands

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/prompts"

# Start test server
start_test_server

# Generate unique session name for this test
SESSION=$(session_name "prmpt")

# Create session for testing
test_case "setup: create session"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

# =============================================================================
# Test: prompts-list
# =============================================================================

test_case "prompts-list returns prompts"
run_xmcpc "$SESSION" prompts-list
assert_success
assert_not_empty "$STDOUT"
test_pass

test_case "prompts-list contains expected prompts"
run_mcpc "$SESSION" prompts-list
assert_success
assert_contains "$STDOUT" "greeting"
assert_contains "$STDOUT" "summarize"
test_pass

test_case "prompts-list human output shows descriptions"
run_mcpc "$SESSION" prompts-list
assert_success
assert_contains "$STDOUT" "Generate a greeting"
assert_contains "$STDOUT" "Summarize text"
test_pass

test_case "prompts-list human output shows arguments"
run_mcpc "$SESSION" prompts-list
assert_success
assert_contains "$STDOUT" "Arguments:"
assert_contains "$STDOUT" "name"
assert_contains "$STDOUT" "[required]"
test_pass

test_case "prompts-list --json returns ListPromptsResult"
run_mcpc --json "$SESSION" prompts-list
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '. | type == "object"'
assert_json "$STDOUT" '.prompts | type == "array"'
assert_json "$STDOUT" '.prompts | length == 2'
assert_json "$STDOUT" 'has("nextCursor") | not'
test_pass

test_case "prompts-list --json contains expected fields"
run_mcpc --json "$SESSION" prompts-list
assert_success
assert_json "$STDOUT" '.prompts[0].name'
assert_json "$STDOUT" '.prompts[0].description'
test_pass

test_case "prompts-list --json contains arguments"
run_mcpc --json "$SESSION" prompts-list
assert_success
# greeting prompt has arguments
greeting=$(echo "$STDOUT" | jq '.prompts[] | select(.name == "greeting")')
assert_json "$greeting" '.arguments'
assert_json "$greeting" '.arguments | length > 0'
test_pass

# =============================================================================
# Test: prompts-get
# =============================================================================

test_case "prompts-get greeting with required arg"
run_xmcpc "$SESSION" prompts-get greeting name:=Alice
assert_success
assert_contains "$STDOUT" "Alice"
test_pass

test_case "prompts-get greeting with style=formal"
run_xmcpc "$SESSION" prompts-get greeting name:=Bob style:=formal
assert_success
assert_contains "$STDOUT" "Good day"
assert_contains "$STDOUT" "Bob"
test_pass

test_case "prompts-get greeting with style=casual"
run_xmcpc "$SESSION" prompts-get greeting name:=Charlie style:=casual
assert_success
assert_contains "$STDOUT" "Hey"
assert_contains "$STDOUT" "Charlie"
test_pass

test_case "prompts-get summarize with text"
run_xmcpc "$SESSION" prompts-get summarize 'text:=This is a long text that needs summarization.' maxLength:=50
assert_success
assert_contains "$STDOUT" "summarize"
assert_contains "$STDOUT" "50"
test_pass

test_case "prompts-get --json returns valid JSON"
run_mcpc --json "$SESSION" prompts-get greeting name:=Test
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '.messages'
assert_json "$STDOUT" '.messages | length > 0'
test_pass

test_case "prompts-get --json contains message structure"
run_mcpc --json "$SESSION" prompts-get greeting name:=Test
assert_success
assert_json "$STDOUT" '.messages[0].role'
assert_json "$STDOUT" '.messages[0].content'
test_pass

test_case "prompts-get unknown prompt fails"
run_mcpc "$SESSION" prompts-get nonexistent foo:=bar
assert_failure
test_pass

# =============================================================================
# Test: prompts-get with inline JSON args
# =============================================================================

test_case "prompts-get with inline JSON args"
run_xmcpc "$SESSION" prompts-get greeting '{"name":"JSONUser","style":"formal"}'
assert_success
assert_contains "$STDOUT" "JSONUser"
assert_contains "$STDOUT" "Good day"
test_pass

# =============================================================================
# Cleanup
# =============================================================================

test_case "cleanup: close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
