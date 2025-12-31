#!/bin/bash
# Test: Human-readable output formatting
# Ensures human output contains all important information

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/human-output"

# Start test server
start_test_server

# Generate unique session name for this test
SESSION=$(session_name "human-out")

# Create session for testing
test_case "setup: create session"
run_mcpc "$TEST_SERVER_URL" session "$SESSION"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

# =============================================================================
# Test: tools-list human output
# =============================================================================

test_case "tools-list contains header with count"
run_mcpc "$SESSION" tools-list
assert_success
assert_contains "$STDOUT" "Available tools"
test_pass

test_case "tools-list contains tool names"
run_mcpc "$SESSION" tools-list
assert_success
assert_contains "$STDOUT" "echo"
assert_contains "$STDOUT" "add"
test_pass

test_case "tools-list contains descriptions"
run_mcpc "$SESSION" tools-list
assert_success
assert_contains "$STDOUT" "Returns the input message"
test_pass

test_case "tools-list contains Input section"
run_mcpc "$SESSION" tools-list
assert_success
assert_contains "$STDOUT" "Input:"
test_pass

test_case "tools-list contains parameter info"
run_mcpc "$SESSION" tools-list
assert_success
# Should show parameter with type and [required]
assert_contains "$STDOUT" "message"
assert_contains "$STDOUT" "string"
assert_contains "$STDOUT" "[required]"
test_pass

# =============================================================================
# Test: resources-list human output
# =============================================================================

test_case "resources-list contains header with count"
run_mcpc "$SESSION" resources-list
assert_success
assert_contains "$STDOUT" "Available resources"
test_pass

test_case "resources-list contains resource URIs"
run_mcpc "$SESSION" resources-list
assert_success
assert_contains "$STDOUT" "test://static/hello"
test_pass

test_case "resources-list contains MIME types"
run_mcpc "$SESSION" resources-list
assert_success
assert_contains "$STDOUT" "text/plain"
test_pass

test_case "resources-list contains descriptions"
run_mcpc "$SESSION" resources-list
assert_success
assert_contains "$STDOUT" "static test resource"
test_pass

# =============================================================================
# Test: resources-templates-list human output
# =============================================================================

test_case "resources-templates-list contains header"
run_mcpc "$SESSION" resources-templates-list
assert_success
assert_contains "$STDOUT" "Available resource templates"
test_pass

test_case "resources-templates-list contains URI templates"
run_mcpc "$SESSION" resources-templates-list
assert_success
assert_contains "$STDOUT" "test://file/{path}"
test_pass

# =============================================================================
# Test: prompts-list human output
# =============================================================================

test_case "prompts-list contains header with count"
run_mcpc "$SESSION" prompts-list
assert_success
assert_contains "$STDOUT" "Available prompts"
test_pass

test_case "prompts-list contains prompt names"
run_mcpc "$SESSION" prompts-list
assert_success
assert_contains "$STDOUT" "greeting"
assert_contains "$STDOUT" "summarize"
test_pass

test_case "prompts-list contains descriptions"
run_mcpc "$SESSION" prompts-list
assert_success
assert_contains "$STDOUT" "Generate a greeting"
test_pass

test_case "prompts-list contains arguments section"
run_mcpc "$SESSION" prompts-list
assert_success
assert_contains "$STDOUT" "Arguments:"
test_pass

test_case "prompts-list shows required arguments"
run_mcpc "$SESSION" prompts-list
assert_success
# The "name" argument of greeting prompt is required
assert_contains "$STDOUT" "name"
assert_contains "$STDOUT" "[required]"
test_pass

# =============================================================================
# Test: server info human output
# =============================================================================

test_case "server info contains server name"
run_mcpc "$SESSION"
assert_success
assert_contains "$STDOUT" "e2e-test-server"
test_pass

test_case "server info contains capabilities"
run_mcpc "$SESSION"
assert_success
assert_contains "$STDOUT" "Capabilities:"
assert_contains "$STDOUT" "tools"
test_pass

test_case "server info contains available commands"
run_mcpc "$SESSION"
assert_success
assert_contains "$STDOUT" "Available commands:"
assert_contains "$STDOUT" "tools-list"
test_pass

# =============================================================================
# Test: tools-call human output
# =============================================================================

test_case "tools-call shows result"
run_mcpc "$SESSION" tools-call echo --args message="Hello World"
assert_success
assert_contains "$STDOUT" "Hello World"
test_pass

# =============================================================================
# Test: Consistent formatting between commands
# =============================================================================

test_case "all list commands use separator lines"
run_mcpc "$SESSION" tools-list
assert_success
assert_contains "$STDOUT" "---"

run_mcpc "$SESSION" resources-list
assert_success
assert_contains "$STDOUT" "---"

run_mcpc "$SESSION" prompts-list
assert_success
assert_contains "$STDOUT" "---"
test_pass

# Cleanup
test_case "cleanup: close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
