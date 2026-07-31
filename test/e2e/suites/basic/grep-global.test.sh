#!/bin/bash
# Test: Global grep command (search across all sessions)
# Tests mcpc grep <pattern> without a session target, searching all active sessions

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/grep-global" --isolated

# Start test server
start_test_server

# Generate unique session names
SESSION1=$(session_name "grep-g1")
SESSION2=$(session_name "grep-g2")

# =============================================================================
# Setup: create two sessions to the same test server
# =============================================================================

test_case "setup: create first session"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION1" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION1")
test_pass

test_case "setup: create second session"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION2" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION2")
test_pass

# =============================================================================
# Test: Global grep matches across sessions
# =============================================================================

test_case "global grep matches tools across sessions"
run_mcpc grep "echo"
assert_success
assert_contains "$STDOUT" "echo"
# Both sessions should appear in output
assert_contains "$STDOUT" "$SESSION1"
assert_contains "$STDOUT" "$SESSION2"
test_pass

test_case "global grep with no matches returns exit code 1"
run_mcpc grep "zzz_nonexistent_zzz"
assert_exit_code 1
test_pass

test_case "global grep matches tool by description"
run_mcpc grep "Returns the input"
assert_success
assert_contains "$STDOUT" "echo"
test_pass

# =============================================================================
# Test: Global grep with type flags
# =============================================================================

test_case "global grep default does not search resources"
run_mcpc grep "static"
assert_exit_code 1
test_pass

test_case "global grep --resources searches resources"
run_mcpc grep "static" --resources
assert_success
assert_contains "$STDOUT" "test://static/hello"
test_pass

test_case "global grep --prompts searches prompts"
run_mcpc grep "greeting" --prompts
assert_success
assert_contains "$STDOUT" "greeting"
test_pass

test_case "global grep --tools --resources searches both"
run_mcpc grep "echo" --tools --resources
assert_success
assert_contains "$STDOUT" "echo"
test_pass

# =============================================================================
# Test: Global grep with regex
# =============================================================================

test_case "global grep -E regex pattern matches"
run_mcpc grep -E "echo|add"
assert_success
assert_contains "$STDOUT" "echo"
assert_contains "$STDOUT" "add"
test_pass

# =============================================================================
# Test: Global grep case sensitivity
# =============================================================================

test_case "global grep is case-insensitive by default"
run_mcpc grep "ECHO"
assert_success
assert_contains "$STDOUT" "echo"
test_pass

test_case "global grep --case-sensitive respects case"
run_mcpc grep "ECHO" --case-sensitive
assert_exit_code 1
test_pass

# =============================================================================
# Test: Global grep JSON output
# =============================================================================

test_case "global grep --json returns valid JSON with sessions array"
run_mcpc --json grep "echo"
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '[.sessions[] | select(.status == "live")] | length > 0'
assert_json "$STDOUT" '.totalMatches.tools > 0'
test_pass

test_case "global grep --json sessions contain name and status"
run_mcpc --json grep "echo"
assert_success
assert_json "$STDOUT" '.sessions[0].name != null'
assert_json "$STDOUT" '.sessions[0].status == "live"'
assert_json "$STDOUT" '[.sessions[] | select(.tools | length > 0)] | length > 0'
test_pass

test_case "global grep --json with no matches includes sessions with empty arrays"
run_mcpc --json grep "zzz_nonexistent_zzz"
assert_exit_code 1
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '.totalMatches.tools == 0'
assert_json "$STDOUT" '.totalMatches.resources == 0'
assert_json "$STDOUT" '.totalMatches.prompts == 0'
# Sessions are still present (they were queried, just no matches)
assert_json "$STDOUT" '[.sessions[] | select(.status == "live")] | length > 0'
test_pass

test_case "global grep --json --resources searches only resources"
run_mcpc --json grep "static" --resources
assert_success
assert_json "$STDOUT" '[.sessions[] | select(.resources | length > 0)] | length > 0'
assert_json "$STDOUT" '[.sessions[] | select(.status == "live")] | first | .tools | length == 0'
test_pass

# =============================================================================
# Test: Global grep with --max-results
# =============================================================================

test_case "global grep -m limits results"
run_mcpc --json grep "e" --tools --resources --prompts -m 1
assert_success
# totalMatches should be > 1 but only 1 shown
assert_json "$STDOUT" '(.totalMatches.tools + .totalMatches.resources + .totalMatches.prompts) > 1'
# Count displayed items across all sessions (only live sessions have arrays)
DISPLAYED=$(echo "$STDOUT" | jq '[.sessions[] | select(.status == "live") | (.tools | length) + (.resources | length) + (.prompts | length)] | add')
assert_eq "$DISPLAYED" "1"
test_pass

# =============================================================================
# Test: Global grep with instructions
# =============================================================================

test_case "global grep default matches instructions"
run_mcpc grep "sample tools, resources, and prompts"
assert_success
assert_contains "$STDOUT" "Instructions"
test_pass

test_case "global grep --json includes instructions in results"
run_mcpc --json grep "sample tools, resources, and prompts"
assert_success
assert_json "$STDOUT" '[.sessions[] | select(.instructions | type == "string")] | length > 0'
test_pass

# =============================================================================
# Test: Server with limited capabilities (no tools/prompts)
# =============================================================================

# Start a second server with no tools and no prompts
MINIMAL_SERVER_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')
cd "$PROJECT_ROOT"
env PORT=$MINIMAL_SERVER_PORT NO_TOOLS=true NO_PROMPTS=true $TSX test/e2e/server/index.ts >"$_TEST_RUN_DIR/minimal-server.log" 2>&1 &
_MINIMAL_SERVER_PID=$!
# Wait for it to be ready
waited=0
while ! curl -s "http://localhost:$MINIMAL_SERVER_PORT/health" >/dev/null 2>&1; do
  sleep 0.2
  ((waited++)) || true
  if [[ $waited -ge 50 ]]; then
    echo "Error: Minimal test server failed to start" >&2
    cat "$_TEST_RUN_DIR/minimal-server.log" >&2
    kill $_MINIMAL_SERVER_PID 2>/dev/null || true
    exit 1
  fi
done
MINIMAL_SERVER_URL="http://localhost:$MINIMAL_SERVER_PORT"
_create_test_auth_profile "localhost:$MINIMAL_SERVER_PORT"
echo "# Minimal server started at $MINIMAL_SERVER_URL (PID: $_MINIMAL_SERVER_PID)"

SESSION_MINIMAL=$(session_name "grep-min")

test_case "setup: create session to minimal server (no tools, no prompts)"
run_mcpc connect "$MINIMAL_SERVER_URL" "$SESSION_MINIMAL" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION_MINIMAL")
test_pass

test_case "grep tool name does not error on minimal server (gracefully skips)"
run_mcpc "$SESSION_MINIMAL" grep "echo"
# No tools capability, so no tools match — but should not error
assert_exit_code 1
test_pass

test_case "grep --resources on minimal server returns resources"
run_mcpc "$SESSION_MINIMAL" grep "static" --resources
assert_success
assert_contains "$STDOUT" "test://static/hello"
test_pass

test_case "grep --prompts on minimal server returns no matches (no prompts capability)"
run_mcpc "$SESSION_MINIMAL" grep "greeting" --prompts
assert_exit_code 1
test_pass

test_case "grep instructions on minimal server still works"
run_mcpc "$SESSION_MINIMAL" grep "sample tools" --instructions
assert_success
assert_contains "$STDOUT" "Instructions"
test_pass

test_case "global grep with mixed-capability sessions shows results from both"
# SESSION1 has full capabilities, SESSION_MINIMAL has only resources + instructions
run_mcpc grep "e" --tools --resources --instructions
assert_success
# SESSION1 should have tools
assert_contains "$STDOUT" "$SESSION1"
# SESSION_MINIMAL should appear (has resources + instructions matching)
assert_contains "$STDOUT" "$SESSION_MINIMAL"
test_pass

test_case "cleanup: close minimal session"
run_mcpc "$SESSION_MINIMAL" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION_MINIMAL}")
test_pass

# Kill minimal server (tsx spawns node as child)
pkill -P $_MINIMAL_SERVER_PID 2>/dev/null || true
kill $_MINIMAL_SERVER_PID 2>/dev/null || true
wait $_MINIMAL_SERVER_PID 2>/dev/null || true

# =============================================================================
# Test: Global grep with no sessions
# =============================================================================

test_case "cleanup: close both sessions"
run_mcpc "$SESSION1" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION1}")
run_mcpc "$SESSION2" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION2}")
test_pass

test_case "global grep with no sessions returns exit code 1"
run_mcpc grep "echo"
assert_exit_code 1
test_pass

test_case "global grep --json with no sessions returns empty"
run_mcpc --json grep "echo"
# No sessions means no matches — exit code 1 but valid JSON
assert_exit_code 1
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '.sessions | length == 0'
assert_json "$STDOUT" '.totalMatches.tools == 0'
test_pass

test_done
