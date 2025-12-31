#!/bin/bash
# Test: Resources operations (list, read, templates)
# Tests resources-list, resources-read, and resources-templates-list commands

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/resources"

# Start test server
start_test_server

# Generate unique session name for this test
SESSION=$(session_name "res")

# Create session for testing
test_case "setup: create session"
run_mcpc "$TEST_SERVER_URL" session "$SESSION"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

# =============================================================================
# Test: resources-list
# =============================================================================

test_case "resources-list returns resources"
run_xmcpc "$SESSION" resources-list
assert_success
assert_not_empty "$STDOUT"
test_pass

test_case "resources-list contains expected URIs"
run_mcpc "$SESSION" resources-list
assert_success
assert_contains "$STDOUT" "test://static/hello"
assert_contains "$STDOUT" "test://static/json"
assert_contains "$STDOUT" "test://dynamic/time"
test_pass

test_case "resources-list human output shows MIME types"
run_mcpc "$SESSION" resources-list
assert_success
assert_contains "$STDOUT" "text/plain"
assert_contains "$STDOUT" "application/json"
test_pass

test_case "resources-list human output shows descriptions"
run_mcpc "$SESSION" resources-list
assert_success
assert_contains "$STDOUT" "static test resource"
test_pass

test_case "resources-list --json returns valid array"
run_mcpc --json "$SESSION" resources-list
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '. | type == "array"'
assert_json "$STDOUT" '. | length == 3'
test_pass

test_case "resources-list --json contains expected fields"
run_mcpc --json "$SESSION" resources-list
assert_success
# Check first resource has required fields
assert_json "$STDOUT" '.[0].uri'
assert_json "$STDOUT" '.[0].name'
test_pass

# =============================================================================
# Test: resources-read
# =============================================================================

test_case "resources-read static text resource"
run_xmcpc "$SESSION" resources-read "test://static/hello"
assert_success
assert_contains "$STDOUT" "Hello, World!"
test_pass

test_case "resources-read static JSON resource"
run_xmcpc "$SESSION" resources-read "test://static/json"
assert_success
assert_contains "$STDOUT" "test"
assert_contains "$STDOUT" "42"
test_pass

test_case "resources-read dynamic resource"
# Use run_mcpc (not run_xmcpc) because dynamic resource changes between runs
run_mcpc "$SESSION" resources-read "test://dynamic/time"
assert_success
# Should contain a timestamp (ISO format)
assert_contains "$STDOUT" "T"
assert_contains "$STDOUT" "Z"
test_pass

test_case "resources-read --json returns valid JSON"
run_mcpc --json "$SESSION" resources-read "test://static/hello"
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '.contents'
assert_json "$STDOUT" '.contents | length > 0'
test_pass

test_case "resources-read --json contains content and metadata"
run_mcpc --json "$SESSION" resources-read "test://static/hello"
assert_success
assert_json "$STDOUT" '.contents[0].uri'
assert_json "$STDOUT" '.contents[0].text'
test_pass

test_case "resources-read unknown resource fails"
run_mcpc "$SESSION" resources-read "test://nonexistent"
assert_failure
test_pass

# =============================================================================
# Test: resources-templates-list
# =============================================================================

test_case "resources-templates-list returns templates"
run_xmcpc "$SESSION" resources-templates-list
assert_success
assert_not_empty "$STDOUT"
test_pass

test_case "resources-templates-list contains URI template"
run_mcpc "$SESSION" resources-templates-list
assert_success
assert_contains "$STDOUT" "test://file/{path}"
test_pass

test_case "resources-templates-list human output shows description"
run_mcpc "$SESSION" resources-templates-list
assert_success
assert_contains "$STDOUT" "Access files by path"
test_pass

test_case "resources-templates-list --json returns valid array"
run_mcpc --json "$SESSION" resources-templates-list
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '. | type == "array"'
assert_json "$STDOUT" '. | length >= 1'
test_pass

test_case "resources-templates-list --json contains uriTemplate field"
run_mcpc --json "$SESSION" resources-templates-list
assert_success
assert_json "$STDOUT" '.[0].uriTemplate'
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
