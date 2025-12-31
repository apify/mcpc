#!/bin/bash
# Test: Error handling for invalid inputs

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/errors"

# Test: invalid session name (special characters)
test_case "invalid session name - special characters"
run_xmcpc "@test/invalid" tools-list
assert_failure
test_pass

# Test: non-existent session
test_case "non-existent session"
run_xmcpc @nonexistent-session-$RANDOM tools-list
assert_failure
assert_contains "$STDERR" "not found"
test_pass

# Test: invalid command (Commander.js handles this with plain text, not JSON)
test_case "invalid command"
run_mcpc @test invalid-command-$RANDOM
assert_failure
test_pass

# Test: missing required argument for session command (Commander.js handles this)
test_case "missing required argument for session"
run_mcpc example.com session
assert_failure
test_pass

# Test: invalid URL scheme
test_case "invalid URL scheme"
run_xmcpc "ftp://example.com" tools-list
assert_failure
test_pass

# Test: empty target shows help (special case: help output doesn't support --json)
test_case "empty target shows help"
run_mcpc ""
# Empty string should be treated as no target
assert_success
test_pass

# Test: session name too long
test_case "session name too long"
LONG_NAME="@$(head -c 200 /dev/zero | tr '\0' 'a')"
run_xmcpc "$LONG_NAME" tools-list
assert_failure
test_pass

# Test: session name with spaces
test_case "session name with spaces"
run_xmcpc "@test session" tools-list
assert_failure
test_pass

# Test: invalid target format - just @ symbol
test_case "invalid target - just @ symbol"
run_xmcpc "@" tools-list
assert_failure
test_pass

# Test: double @ in session name
test_case "invalid session name - double @"
run_xmcpc "@@test" tools-list
assert_failure
test_pass

# Test: tools-call with missing tool name (Commander.js)
test_case "tools-call missing tool name"
run_mcpc @nonexistent tools-call
assert_failure
test_pass

# Test: prompts-get with missing prompt name (Commander.js)
test_case "prompts-get missing prompt name"
run_mcpc @nonexistent prompts-get
assert_failure
test_pass

# Test: resources-read with missing URI (Commander.js)
test_case "resources-read missing URI"
run_mcpc @nonexistent resources-read
assert_failure
test_pass

# Test: logging-set-level with missing level (Commander.js)
test_case "logging-set-level missing level"
run_mcpc @nonexistent logging-set-level
assert_failure
test_pass

# Test: unknown option should fail
test_case "unknown option fails"
run_mcpc --unknownoption
assert_failure
assert_contains "$STDERR" "Unknown option"
test_pass

# Test: invalid --clean type should fail
test_case "invalid --clean type fails"
run_mcpc --clean=invalid
assert_failure
assert_contains "$STDERR" "Invalid --clean type"
test_pass

# Test: option that looks like --clean but isn't should fail
test_case "typo option --cleanblah fails"
run_mcpc --cleanblah
assert_failure
assert_contains "$STDERR" "Unknown option"
test_pass

# Test: invalid --header format (missing colon)
test_case "invalid --header format fails"
run_mcpc example.com tools-list --header "InvalidHeader"
assert_failure
assert_contains "$STDERR" "Invalid header format"
test_pass

# Test: invalid --schema-mode value
test_case "invalid --schema-mode fails"
run_mcpc example.com tools-list --schema-mode invalid
assert_failure
assert_contains "$STDERR" "Invalid --schema-mode"
test_pass

# Test: non-numeric --timeout value
test_case "non-numeric --timeout fails"
run_mcpc example.com tools-list --timeout notanumber
assert_failure
assert_contains "$STDERR" "Invalid --timeout"
test_pass

# Test: non-existent --config file
test_case "non-existent --config file fails"
run_mcpc --config /nonexistent/config-$RANDOM.json fs tools-list
assert_failure
assert_contains "$STDERR" "not found"
test_pass

# Test: non-existent --schema file
test_case "non-existent --schema file fails"
run_mcpc example.com tools-list --schema /nonexistent/schema-$RANDOM.json
assert_failure
assert_contains "$STDERR" "not found"
test_pass

test_done
