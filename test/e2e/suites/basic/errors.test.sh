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

# Test: reversed hyphenated command suggests correct form
test_case "reversed command suggests tools-list"
run_mcpc @test list-tools
assert_failure
assert_contains "$STDERR" "Unknown command: list-tools"
assert_contains "$STDERR" "Did you mean: mcpc @test tools-list"
test_pass

# Test: reversed resource command
test_case "reversed command suggests resources-list"
run_mcpc @test list-resources
assert_failure
assert_contains "$STDERR" "Did you mean: mcpc @test resources-list"
test_pass

# Test: reversed prompts command
test_case "reversed command suggests prompts-get"
run_mcpc @test get-prompts
assert_failure
assert_contains "$STDERR" "Did you mean: mcpc @test prompts-get"
test_pass

# Test: typo command gets Levenshtein suggestion
test_case "typo command suggests tools-list"
run_mcpc @test tools-lst
assert_failure
assert_contains "$STDERR" "Did you mean: mcpc @test tools-list"
test_pass

# Test: bare "tools" command suggests tools-list
test_case "bare tools suggests tools-list"
run_mcpc @test tools
assert_failure
assert_contains "$STDERR" "Unknown command: tools"
assert_contains "$STDERR" "Did you mean: mcpc @test tools-list"
test_pass

# Test: bare "resources" command suggests resources-list
test_case "bare resources suggests resources-list"
run_mcpc @test resources
assert_failure
assert_contains "$STDERR" "Unknown command: resources"
assert_contains "$STDERR" "Did you mean: mcpc @test resources-list"
test_pass

# Test: bare "prompts" command suggests prompts-list
test_case "bare prompts suggests prompts-list"
run_mcpc @test prompts
assert_failure
assert_contains "$STDERR" "Unknown command: prompts"
assert_contains "$STDERR" "Did you mean: mcpc @test prompts-list"
test_pass

# Test: completely unknown command shows help text but no suggestion
test_case "unknown command shows help pointer"
run_mcpc @test xyzzy-$RANDOM
assert_failure
assert_contains "$STDERR" "Unknown command"
assert_contains "$STDERR" "mcpc @test --help"
test_pass

# Test: unknown command in JSON mode returns JSON error
test_case "unknown command in JSON mode returns JSON"
run_mcpc @test --json list-tools
assert_failure
assert_json_valid "$STDERR" "stderr is valid JSON"
assert_json_eq "$STDERR" ".code" "1"
assert_contains "$STDERR" "Unknown command"
test_pass

# Test: top-level typo command suggests correct form (Levenshtein)
test_case "top-level typo suggests connect"
run_mcpc conect
assert_failure
assert_contains "$STDERR" "Unknown command: conect"
assert_contains "$STDERR" "Did you mean: mcpc connect"
test_pass

# Test: session subcommand used without @session
test_case "session subcommand without @session suggests adding session"
run_mcpc tools-list
assert_failure
assert_contains "$STDERR" "Missing session target for command: tools-list"
assert_contains "$STDERR" "Did you mean: mcpc <@session> tools-list"
test_pass

# Test: MCP JSON-RPC-style method name without @session is recognized (silent alias)
# and hints the hyphenated form, not the raw method name.
test_case "slash-style method name without @session suggests hyphenated form"
run_mcpc tools/list
assert_failure
assert_contains "$STDERR" "Missing session target for command: tools/list"
assert_contains "$STDERR" "Did you mean: mcpc <@session> tools-list"
test_pass

# Test: unmatched slash-style token is still reported as unknown (no false alias)
test_case "unmatched slash-style token stays unknown"
run_mcpc @test foo/bar
assert_failure
assert_contains "$STDERR" "Unknown command: foo/bar"
test_pass

# Test: bare "tools" without @session suggests session subcommand
test_case "top-level bare tools suggests session subcommand"
run_mcpc tools
assert_failure
assert_contains "$STDERR" "Unknown command: tools"
assert_contains "$STDERR" "Did you mean: mcpc <@session> tools-list"
test_pass

# Test: top-level typo that matches a session subcommand
test_case "top-level typo suggests session subcommand"
run_mcpc tools-lst
assert_failure
assert_contains "$STDERR" "Did you mean: mcpc <@session> tools-list"
test_pass

# Test: connect command missing required arguments (Commander.js handles this)
test_case "connect command missing required arguments"
run_mcpc connect
assert_failure
test_pass

# Test: invalid URL scheme passed to connect
test_case "invalid URL scheme"
run_mcpc connect "ftp://example.com" "@test-$RANDOM"
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

# Test: invalid clean resource type should fail
test_case "invalid clean resource type fails"
run_mcpc clean invalid-type-$RANDOM
assert_failure
test_pass

# Test: option that looks like --clean but isn't should fail
test_case "typo option --cleanblah fails"
run_mcpc --cleanblah
assert_failure
assert_contains "$STDERR" "Unknown option"
test_pass

# Test: invalid --header format (missing colon)
test_case "invalid --header format fails"
run_mcpc connect example.com "@test-$RANDOM" --header "InvalidHeader"
assert_failure
assert_contains "$STDERR" "Invalid header format"
test_pass

# Test: non-numeric --timeout value
test_case "non-numeric --timeout fails"
run_mcpc @nonexistent tools-list --timeout notanumber
assert_failure
assert_contains "$STDERR" "Invalid --timeout"
test_pass

# Test: non-existent config file via connect command
test_case "non-existent config file fails"
run_mcpc connect "/nonexistent/config-$RANDOM.json:fs" "@test-session-$RANDOM"
assert_failure
assert_contains "$STDERR" "not found"
test_pass

test_done
