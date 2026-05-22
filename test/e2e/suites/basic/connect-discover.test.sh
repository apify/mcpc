#!/bin/bash
# Test: `mcpc connect` (no arguments) discovers standard MCP config files
# from the current directory and $HOME and connects every server found.
#
# Covered scenarios:
#  1. No configs at all — command fails with a helpful error listing paths checked
#  2. Project config only (.mcp.json) — discovered and connected
#  3. Global config only (~/.cursor/mcp.json) — discovered and connected
#  4. Project + global with overlapping entry name — project-scope wins, global is skipped
#  5. Re-running discovery reuses existing sessions (no duplicates)
#  6. `@session` argument is rejected
#  7. JSON output produces structured data

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/connect-discover" --isolated

start_test_server

# Use isolated HOME so discovery only sees files we create here.
# os.homedir() reads $HOME on Unix/macOS and $USERPROFILE on Windows.
FAKE_HOME="$TEST_TMP/fake-home"
FAKE_CWD="$TEST_TMP/fake-cwd"
mkdir -p "$FAKE_HOME" "$FAKE_CWD"

# Wrapper that runs mcpc with HOME/USERPROFILE overridden and with cwd set to FAKE_CWD.
# Captures STDOUT/STDERR/EXIT_CODE like run_mcpc.
run_mcpc_discover() {
  local stdout_file="$TEST_TMP/stdout.$$.$RANDOM"
  local stderr_file="$TEST_TMP/stderr.$$.$RANDOM"

  set +e
  (cd "$FAKE_CWD" && HOME="$FAKE_HOME" USERPROFILE="$FAKE_HOME" $MCPC "$@") \
    >"$stdout_file" 2>"$stderr_file"
  EXIT_CODE=$?
  set -e

  STDOUT=$(cat "$stdout_file")
  STDERR=$(cat "$stderr_file")

  {
    echo "=== run_mcpc_discover $* ==="
    echo "Exit code: $EXIT_CODE"
    echo "--- stdout ---"
    cat "$stdout_file"
    echo "--- stderr ---"
    cat "$stderr_file"
    echo "=== end ==="
    echo ""
  } >> "$_TEST_RUN_DIR/commands.log"

  rm -f "$stdout_file" "$stderr_file"
}

# =============================================================================
# Test: No configs found — helpful error
# =============================================================================

test_case "no MCP configs found — command fails with search-path message"
run_mcpc_discover connect
assert_failure "connect with no configs should fail"
assert_contains "$STDERR" "No MCP config files found"
assert_contains "$STDERR" "Searched:"
# Error should include project-level and global-level paths
assert_contains "$STDERR" ".mcp.json"
assert_contains "$STDERR" ".cursor"
test_pass

# =============================================================================
# Test: Project-scope .mcp.json is discovered and connected
# =============================================================================

test_case "project-scope .mcp.json is discovered and connected"
cat > "$FAKE_CWD/.mcp.json" <<EOF
{
  "mcpServers": {
    "discover-project": {
      "url": "$TEST_SERVER_URL",
      "headers": { "X-Test": "true" }
    }
  }
}
EOF
_SESSIONS_CREATED+=("@discover-project")

run_mcpc_discover connect
assert_success "connect with project-scope config should succeed"
assert_contains "$STDOUT" "Found 1 MCP config file"
assert_contains "$STDOUT" ".mcp.json"
assert_contains "$STDOUT" "@discover-project"
assert_contains "$STDOUT" "connecting"
test_pass

# =============================================================================
# Test: Global-scope ~/.cursor/mcp.json is discovered (after removing project)
# =============================================================================

test_case "global-scope ~/.cursor/mcp.json is discovered and connected"
rm -f "$FAKE_CWD/.mcp.json"
# Close the previously-created project session so the global test starts clean.
run_mcpc "@discover-project" close || true

mkdir -p "$FAKE_HOME/.cursor"
cat > "$FAKE_HOME/.cursor/mcp.json" <<EOF
{
  "mcpServers": {
    "discover-global": {
      "url": "$TEST_SERVER_URL",
      "headers": { "X-Test": "true" }
    }
  }
}
EOF
_SESSIONS_CREATED+=("@discover-global")

run_mcpc_discover connect
assert_success "connect with global-scope config should succeed"
# On Windows the printed path uses backslashes (.cursor\mcp.json); normalize
# both directions so the assertion works on POSIX and Git Bash.
normalized_stdout="${STDOUT//\\//}"
assert_contains "$normalized_stdout" ".cursor/mcp.json"
assert_contains "$STDOUT" "@discover-global"
test_pass

# =============================================================================
# Test: Project + global with same entry name — project wins, global is skipped
# =============================================================================

test_case "project scope wins over global on entry-name collision"
# Close previous session first
run_mcpc "@discover-global" close || true
rm -f "$FAKE_HOME/.cursor/mcp.json"

# Both project (.mcp.json) and global (~/.cursor/mcp.json) define `shared` entry.
cat > "$FAKE_CWD/.mcp.json" <<EOF
{
  "mcpServers": {
    "shared": {
      "url": "$TEST_SERVER_URL",
      "headers": { "X-Test": "true", "X-Scope": "project" }
    }
  }
}
EOF
mkdir -p "$FAKE_HOME/.cursor"
cat > "$FAKE_HOME/.cursor/mcp.json" <<EOF
{
  "mcpServers": {
    "shared": {
      "url": "$TEST_SERVER_URL",
      "headers": { "X-Test": "true", "X-Scope": "global" }
    }
  }
}
EOF
_SESSIONS_CREATED+=("@shared")

run_mcpc_discover connect
assert_success "discovery with collision should succeed"
# Must show two config files discovered, one duplicate skipped
assert_contains "$STDOUT" "Found 2 MCP config files"
assert_contains "$STDOUT" "skipped (duplicate)"
assert_contains "$STDOUT" "@shared"
test_pass

# =============================================================================
# Test: JSON output is structured and lists discovered/results/skipped
# =============================================================================

test_case "--json output is an array of InitializeResult entries with _mcpc metadata"
run_mcpc_discover --json connect
assert_success "json discovery should succeed"

# Output is a flat array of ConnectResultEntry, one per session (active/created/failed/skipped)
total_count=$(echo "$STDOUT" | jq 'length')
results_count=$(echo "$STDOUT" | jq '[.[] | select(._mcpc.status == "active" or ._mcpc.status == "created")] | length')
skipped_count=$(echo "$STDOUT" | jq '[.[] | select(._mcpc.status == "skipped")] | length')
discovered_count=$(echo "$STDOUT" | jq '[.[]._mcpc.configFile] | unique | length')

assert_eq "$total_count" "2" "array should contain 2 entries (1 connected + 1 skipped duplicate)"
assert_eq "$discovered_count" "2" "entries should reference 2 distinct config files"
assert_eq "$results_count" "1" "should report 1 connected session (duplicate skipped)"
assert_eq "$skipped_count" "1" "should report 1 skipped duplicate"

# Duplicate should reference the correct session name and skipReason
skipped_name=$(echo "$STDOUT" | jq -r '[.[] | select(._mcpc.status == "skipped")][0]._mcpc.sessionName')
skipped_reason=$(echo "$STDOUT" | jq -r '[.[] | select(._mcpc.status == "skipped")][0]._mcpc.skipReason')
assert_eq "$skipped_name" "@shared"
assert_eq "$skipped_reason" "duplicate"

# Connected entry should expose InitializeResult fields (serverInfo at minimum)
connected_name=$(echo "$STDOUT" | jq -r '[.[] | select(._mcpc.status == "active" or ._mcpc.status == "created")][0]._mcpc.sessionName')
connected_server=$(echo "$STDOUT" | jq -r '[.[] | select(._mcpc.status == "active" or ._mcpc.status == "created")][0].serverInfo.name // empty')
assert_eq "$connected_name" "@shared"
if [[ -z "$connected_server" ]]; then
  test_fail "connected entry should include serverInfo.name from InitializeResult"
  exit 1
fi
test_pass

# =============================================================================
# Test: Re-running discovery reuses existing sessions (no duplicates)
# =============================================================================

test_case "re-running discovery reuses existing session (no @shared-2)"
run_mcpc_discover connect
assert_success "re-run discovery should succeed"
assert_contains "$STDOUT" "already active"

# Session list must not grow (no @shared-2 / duplicates)
run_mcpc --json
total=$(echo "$STDOUT" | jq '.sessions | length')
assert_eq "$total" "1" "should still have exactly 1 session after re-discovery"

suffixed=$(echo "$STDOUT" | jq -r '[.sessions[] | select(.name | test("^@shared-[0-9]+$"))] | length')
assert_eq "$suffixed" "0" "no suffixed @shared-N variants should exist"
test_pass

# =============================================================================
# Test: Session is functional after discovery
# =============================================================================

test_case "discovered session is usable for tools-list"
run_mcpc "@shared" tools-list
assert_success "tools-list should work on discovered session"
assert_contains "$STDOUT" "echo"
test_pass

test_done
