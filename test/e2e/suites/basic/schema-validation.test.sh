#!/bin/bash
# Test: Schema validation with --schema and --schema-mode options
# Tests that tool and prompt schemas can be validated against expected schemas

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/schema-validation"

# Start test server
start_test_server

# Generate unique session name for this test
SESSION=$(session_name "schema")

# Create session for testing
test_case "setup: create session"
run_mcpc "$TEST_SERVER_URL" session "$SESSION"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

# =============================================================================
# Setup: Save tool and prompt schemas for validation
# =============================================================================

# Save the echo tool schema
test_case "setup: save echo tool schema"
run_mcpc --json "$SESSION" tools-get echo
assert_success
echo "$STDOUT" > "$TEST_TMP/echo-schema.json"
test_pass

# Save the greeting prompt schema (from prompts-list)
test_case "setup: save greeting prompt schema"
run_mcpc --json "$SESSION" prompts-list
assert_success
# Extract the greeting prompt from the array
echo "$STDOUT" | jq '.[] | select(.name == "greeting")' > "$TEST_TMP/greeting-schema.json"
test_pass

# =============================================================================
# Test: tools-call with --schema (compatible mode, default)
# =============================================================================

test_case "tools-call with valid schema passes"
run_mcpc "$SESSION" tools-call echo --args message="test" --schema "$TEST_TMP/echo-schema.json"
assert_success
test_pass

test_case "tools-call with valid schema (JSON mode)"
run_mcpc --json "$SESSION" tools-call echo --args message="test" --schema "$TEST_TMP/echo-schema.json"
assert_success
assert_json_valid "$STDOUT"
test_pass

# =============================================================================
# Test: tools-get with --schema validation
# =============================================================================

test_case "tools-get with valid schema passes"
run_mcpc "$SESSION" tools-get echo --schema "$TEST_TMP/echo-schema.json"
assert_success
test_pass

# =============================================================================
# Test: --schema-mode options
# =============================================================================

test_case "tools-call with --schema-mode=strict passes for exact match"
run_mcpc "$SESSION" tools-call echo --args message="test" \
  --schema "$TEST_TMP/echo-schema.json" --schema-mode strict
assert_success
test_pass

test_case "tools-call with --schema-mode=compatible passes"
run_mcpc "$SESSION" tools-call echo --args message="test" \
  --schema "$TEST_TMP/echo-schema.json" --schema-mode compatible
assert_success
test_pass

test_case "tools-call with --schema-mode=ignore passes"
run_mcpc "$SESSION" tools-call echo --args message="test" \
  --schema "$TEST_TMP/echo-schema.json" --schema-mode ignore
assert_success
test_pass

# =============================================================================
# Test: prompts-get with --schema validation
# =============================================================================

test_case "prompts-get with valid schema passes"
run_mcpc "$SESSION" prompts-get greeting --args name=Test \
  --schema "$TEST_TMP/greeting-schema.json"
assert_success
test_pass

test_case "prompts-get with valid schema (JSON mode)"
run_mcpc --json "$SESSION" prompts-get greeting --args name=Test \
  --schema "$TEST_TMP/greeting-schema.json"
assert_success
assert_json_valid "$STDOUT"
test_pass

# =============================================================================
# Test: Schema validation failures
# =============================================================================

# Create a modified schema with wrong name
test_case "setup: create mismatched schema"
cat > "$TEST_TMP/wrong-name-schema.json" << 'EOF'
{
  "name": "wrong-tool-name",
  "description": "A tool with wrong name",
  "inputSchema": {
    "type": "object",
    "properties": {
      "message": { "type": "string" }
    }
  }
}
EOF
test_pass

test_case "tools-call fails with mismatched tool name"
run_mcpc "$SESSION" tools-call echo --args message="test" \
  --schema "$TEST_TMP/wrong-name-schema.json"
assert_failure
assert_contains "$STDERR" "name mismatch"
test_pass

test_case "tools-call failure shows JSON error with --json"
run_mcpc --json "$SESSION" tools-call echo --args message="test" \
  --schema "$TEST_TMP/wrong-name-schema.json"
assert_failure
assert_json_valid "$STDERR"
assert_contains "$STDERR" "name mismatch"
test_pass

# Create a schema with missing required field
test_case "setup: create schema with extra required field"
cat > "$TEST_TMP/extra-required-schema.json" << 'EOF'
{
  "name": "echo",
  "description": "Echo a message back",
  "inputSchema": {
    "type": "object",
    "properties": {
      "message": { "type": "string" },
      "extra": { "type": "string" }
    },
    "required": ["message", "extra"]
  }
}
EOF
test_pass

test_case "tools-call fails when server removes required field"
# The actual server doesn't have "extra" as required, so validation should fail
# in compatible mode when extra is in expected but not in actual
run_mcpc "$SESSION" tools-call echo --args message="test" \
  --schema "$TEST_TMP/extra-required-schema.json"
assert_failure
assert_contains "$STDERR" "extra"
test_pass

# =============================================================================
# Test: Schema file errors
# =============================================================================

test_case "tools-call fails with nonexistent schema file"
run_mcpc "$SESSION" tools-call echo --args message="test" \
  --schema "/nonexistent/schema.json"
assert_failure
assert_contains "$STDERR" "not found"
test_pass

test_case "tools-call fails with invalid JSON schema file"
echo "not valid json" > "$TEST_TMP/invalid-schema.json"
run_mcpc "$SESSION" tools-call echo --args message="test" \
  --schema "$TEST_TMP/invalid-schema.json"
assert_failure
assert_contains "$STDERR" "Invalid JSON"
test_pass

# =============================================================================
# Test: Invalid --schema-mode value
# =============================================================================

test_case "invalid --schema-mode value fails"
run_mcpc "$SESSION" tools-call echo --args message="test" \
  --schema "$TEST_TMP/echo-schema.json" --schema-mode invalid
assert_failure
assert_contains "$STDERR" "Invalid schema mode"
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
