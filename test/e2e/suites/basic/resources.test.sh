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
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
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
assert_json "$STDOUT" '. | length == 5'
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
# Test: resources-read binary content, --raw, and -o (file output)
# =============================================================================

# Expected bytes of test://static/binary (base64 AAECA/z9/v8=)
EXPECTED_BIN="$TEST_TMP/expected-binary.bin"
printf '\x00\x01\x02\x03\xfc\xfd\xfe\xff' > "$EXPECTED_BIN"

test_case "resources-read binary resource shows summary, not raw bytes"
run_mcpc "$SESSION" resources-read "test://static/binary"
assert_success
assert_contains "$STDOUT" "application/octet-stream"
assert_contains "$STDOUT" "binary"
assert_contains "$STDOUT" "8 bytes"
# The base64 payload must not be dumped into the pretty view
if [[ "$STDOUT" == *"AAECA/z9/v8="* ]]; then
  test_fail "binary content should not be printed in human mode"
  exit 1
fi
test_pass

test_case "resources-read --raw prints bare text content"
run_mcpc "$SESSION" resources-read "test://static/hello" --raw
assert_success
assert_eq "$STDOUT" "Hello, World!" "raw output should be the exact content"
test_pass

test_case "resources-read --raw pipes binary bytes when stdout is not a TTY"
# Bypass run_mcpc: binary output contains NUL bytes that bash variables drop
OUT_RAW="$TEST_TMP/binary-raw.bin"
set +e
$MCPC "$SESSION" resources-read "test://static/binary" --raw > "$OUT_RAW" 2>/dev/null
RAW_EXIT=$?
set -e
assert_eq "$RAW_EXIT" "0" "raw binary read should succeed when stdout is redirected"
if ! cmp -s "$EXPECTED_BIN" "$OUT_RAW"; then
  test_fail "piped raw binary output should match the decoded blob bytes"
  exit 1
fi
test_pass

test_case "resources-read -o saves text resource to file"
OUT_TEXT="$TEST_TMP/hello-resource.txt"
run_mcpc "$SESSION" resources-read "test://static/hello" -o "$OUT_TEXT"
assert_success
assert_contains "$STDOUT" "Saved"
assert_file_exists "$OUT_TEXT"
assert_eq "$(cat "$OUT_TEXT")" "Hello, World!" "saved file should contain the resource text"
test_pass

test_case "resources-read -o decodes binary blob to exact bytes"
OUT_BIN="$TEST_TMP/binary-resource.bin"
run_mcpc "$SESSION" resources-read "test://static/binary" -o "$OUT_BIN"
assert_success
assert_file_exists "$OUT_BIN"
if ! cmp -s "$EXPECTED_BIN" "$OUT_BIN"; then
  test_fail "saved binary file should match the decoded blob bytes"
  exit 1
fi
test_pass

test_case "resources-read -o --json prints summary object"
OUT_JSON="$TEST_TMP/hello-resource2.txt"
run_mcpc --json "$SESSION" resources-read "test://static/hello" -o "$OUT_JSON"
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '.uri == "test://static/hello"'
assert_json "$STDOUT" '.bytes == 13'
assert_json "$STDOUT" '.mimeType == "text/plain"'
assert_json "$STDOUT" '.file | length > 0'
assert_file_exists "$OUT_JSON"
test_pass

test_case "resources-read -o creates parent directories"
OUT_NESTED="$TEST_TMP/nested/dir/resource.txt"
run_mcpc "$SESSION" resources-read "test://static/hello" -o "$OUT_NESTED"
assert_success
assert_file_exists "$OUT_NESTED"
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
