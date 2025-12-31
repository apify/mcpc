#!/bin/bash
# Test: Pagination handling for list operations

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/pagination"

# Start test server with pagination enabled (2 items per page)
start_test_server PAGINATION_SIZE=2

# Generate unique session name
SESSION=$(session_name "pagination")

# Create session
test_case "create session"
run_mcpc "$TEST_SERVER_URL" session "$SESSION"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

# Test: tools-list fetches all pages
test_case "tools-list fetches all pages"
run_xmcpc "$SESSION" tools-list
assert_success
# Server has 5 tools, pagination is 2 per page, so we need 3 pages
# All tools should be present
assert_contains "$STDOUT" "echo"
assert_contains "$STDOUT" "add"
assert_contains "$STDOUT" "fail"
assert_contains "$STDOUT" "slow"
assert_contains "$STDOUT" "write-file"
test_pass

# Test: tools-list --json returns all tools
test_case "tools-list --json returns all tools"
run_xmcpc "$SESSION" tools-list --json
assert_success
# Count tools in JSON output (returns array directly)
tool_count=$(echo "$STDOUT" | jq 'length')
assert_eq "$tool_count" "5" "should have all 5 tools"
test_pass

# Test: resources-list fetches all pages
test_case "resources-list fetches all pages"
run_xmcpc "$SESSION" resources-list
assert_success
# Server has 3 resources
assert_contains "$STDOUT" "Hello Resource"
assert_contains "$STDOUT" "JSON Resource"
assert_contains "$STDOUT" "Current Time"
test_pass

# Test: resources-list --json returns all resources
test_case "resources-list --json returns all resources"
run_xmcpc "$SESSION" resources-list --json
assert_success
# Returns array directly
resource_count=$(echo "$STDOUT" | jq 'length')
assert_eq "$resource_count" "3" "should have all 3 resources"
test_pass

# Test: prompts-list fetches all pages
test_case "prompts-list fetches all pages"
run_xmcpc "$SESSION" prompts-list
assert_success
# Server has 2 prompts
assert_contains "$STDOUT" "greeting"
assert_contains "$STDOUT" "summarize"
test_pass

# Test: prompts-list --json returns all prompts
test_case "prompts-list --json returns all prompts"
run_xmcpc "$SESSION" prompts-list --json
assert_success
# Returns array directly
prompt_count=$(echo "$STDOUT" | jq 'length')
assert_eq "$prompt_count" "2" "should have all 2 prompts"
test_pass

test_done
