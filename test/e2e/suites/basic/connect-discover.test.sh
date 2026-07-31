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
# Test: A config that exists but defines no servers is reported clearly,
#       not misreported as "No MCP config files found" (#255)
# =============================================================================

test_case "empty config (no servers) reports a clear message, not 'not found'"
cat > "$FAKE_CWD/mcp.json" <<EOF
{
  "mcpServers": {}
}
EOF

run_mcpc_discover connect
assert_failure "connect with an empty config should fail"
assert_contains "$STDERR" "No MCP servers to connect"
assert_contains "$STDERR" "defines no servers"
assert_contains "$STDERR" "mcp.json"
# Regression: the present-but-empty file must not be reported as missing
assert_not_contains "$STDERR" "No MCP config files found"

# JSON mode stays machine-readable: empty array, exit 0
run_mcpc_discover --json connect
assert_success "json mode with an empty config should exit 0"
assert_json_valid "$STDOUT"
empty_len=$(echo "$STDOUT" | jq 'length')
assert_eq "$empty_len" "0" "json mode should output an empty array"

rm -f "$FAKE_CWD/mcp.json"
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
assert_contains "$STDOUT" "live"
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

test_case "--json output is an array of server-details entries with _mcpc metadata"
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

# Connected entry should expose the handshake-result fields (serverInfo at minimum)
connected_name=$(echo "$STDOUT" | jq -r '[.[] | select(._mcpc.status == "active" or ._mcpc.status == "created")][0]._mcpc.sessionName')
connected_server=$(echo "$STDOUT" | jq -r '[.[] | select(._mcpc.status == "active" or ._mcpc.status == "created")][0].serverInfo.name // empty')
assert_eq "$connected_name" "@shared"
if [[ -z "$connected_server" ]]; then
  test_fail "connected entry should include serverInfo.name from the handshake result"
  exit 1
fi
test_pass

# =============================================================================
# Test: Re-running discovery reuses existing sessions (no duplicates)
# =============================================================================

test_case "re-running discovery reuses existing session (no @shared-2)"
run_mcpc_discover connect
assert_success "re-run discovery should succeed"
# Already-live sessions are shown inline with the green "live" state
assert_contains "$STDOUT" "● live"

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

# =============================================================================
# Test: A config that exists but defines no servers is still listed alongside
#       configs that do define servers (rather than silently dropped) (#255)
# =============================================================================

test_case "empty config is listed (0 servers) next to a config that has servers"
# Start this final case from a clean discovery state.
run_mcpc "@shared" close || true
rm -f "$FAKE_CWD/.mcp.json" "$FAKE_CWD/mcp.json" "$FAKE_HOME/.cursor/mcp.json"

# One project config with a server + one empty project config alongside it.
cat > "$FAKE_CWD/.mcp.json" <<EOF
{
  "mcpServers": {
    "discover-mixed": {
      "url": "$TEST_SERVER_URL",
      "headers": { "X-Test": "true" }
    }
  }
}
EOF
cat > "$FAKE_CWD/mcp.json" <<EOF
{
  "mcpServers": {}
}
EOF
_SESSIONS_CREATED+=("@discover-mixed")

run_mcpc_discover connect
assert_success "discovery with a populated + empty config should succeed"
assert_contains "$STDOUT" "Found 2 MCP config files"
assert_contains "$STDOUT" "@discover-mixed"
# The empty config must be visibly accounted for, not silently dropped
assert_contains "$STDOUT" "0 servers"
test_pass

# =============================================================================
# Test: connection status is reported inline within each config file — the
#       connected server shows a status badge, stdio servers are marked skipped
#       inline, and the --stdio hint follows the listing (not in a separate block)
# =============================================================================

test_case "status is reported inline per config entry, with the --stdio hint last"
run_mcpc "@discover-mixed" close || true
rm -f "$FAKE_CWD/.mcp.json" "$FAKE_CWD/mcp.json" "$FAKE_HOME/.cursor/mcp.json"

# One HTTP server (connects) + one stdio server (skipped without --stdio). The
# stdio command is never executed because the entry is skipped.
cat > "$FAKE_CWD/.mcp.json" <<EOF
{
  "mcpServers": {
    "discover-http": { "url": "$TEST_SERVER_URL", "headers": { "X-Test": "true" } },
    "discover-stdio": { "command": "true", "args": [] }
  }
}
EOF
_SESSIONS_CREATED+=("@discover-http")

run_mcpc_discover connect
assert_success "discovery with an http + skipped stdio server should succeed"
# The connected server shows its status inline; the stdio server is marked inline.
assert_contains "$STDOUT" "@discover-http"
assert_contains "$STDOUT" "live"
assert_contains "$STDOUT" "○ skipped (stdio)"
# Plain note (not a dim "↳" hint) pointing at --stdio.
assert_contains "$STDOUT" "To include stdio servers, run: mcpc connect --stdio"
assert_not_contains "$STDOUT" "↳ run: mcpc connect --stdio"
# No leftover lowercase mid-sentence "skipped" from the old summary line.
assert_not_contains "$STDOUT" "server. skipped"

# The connected server's inline result must appear before the trailing --stdio hint.
status_line=$(echo "$STDOUT" | grep -n "@discover-http" | tail -1 | cut -d: -f1)
hint_line=$(echo "$STDOUT" | grep -n "mcpc connect --stdio" | head -1 | cut -d: -f1)
if [[ -z "$status_line" || -z "$hint_line" || "$status_line" -gt "$hint_line" ]]; then
  test_fail "inline server status (line ${status_line:-?}) should appear before the --stdio hint (line ${hint_line:-?})"
  exit 1
fi
test_pass

# =============================================================================
# Test: A stdio server already live (from a prior `connect --stdio`) is shown
#       with its live status on a plain `mcpc connect`, not "○ skipped (stdio)",
#       and the --stdio note is omitted when nothing stdio is unconnected (#255)
# =============================================================================

test_case "already-live stdio server shows live (not skipped) on a plain connect"
run_mcpc "@discover-http" close || true
rm -f "$FAKE_CWD/.mcp.json" "$FAKE_CWD/mcp.json" "$FAKE_HOME/.cursor/mcp.json"

# A local stdio MCP server (no network) so we can make a stdio session live.
# Convert to a native path so Windows' node can resolve it — an MSYS path like
# /d/a/... is otherwise misread as a relative path on the current drive (#258).
STDIO_SERVER="$(to_native_path "$PROJECT_ROOT/test/e2e/server/stdio-server.mjs")"
cat > "$FAKE_CWD/.mcp.json" <<EOF
{
  "mcpServers": {
    "discover-live-stdio": {
      "command": "node",
      "args": ["$STDIO_SERVER"]
    }
  }
}
EOF
_SESSIONS_CREATED+=("@discover-live-stdio")

# Connect it as a stdio server, then confirm it is live via a ping.
run_mcpc_discover connect --stdio
assert_success "connect --stdio should connect the stdio server"
run_mcpc "@discover-live-stdio" ping
assert_success "the stdio session should be live and answer ping"

# A plain connect (no --stdio) must show it live, not skipped, and omit the note.
run_mcpc_discover connect
assert_success "plain connect should succeed with an already-live stdio server"
assert_contains "$STDOUT" "@discover-live-stdio"
assert_contains "$STDOUT" "● live"
assert_not_contains "$STDOUT" "○ skipped (stdio)"
assert_not_contains "$STDOUT" "To include stdio servers"
test_pass

# =============================================================================
# Test: Unusable config files are listed inline as "(invalid)" with a reason —
#       invalid JSON, and a project file missing a servers object — counted,
#       not dropped or warned out of band (#255)
# =============================================================================

test_case "unusable config files are listed inline as (invalid) with a reason"
run_mcpc "@discover-live-stdio" close || true
rm -f "$FAKE_CWD/.mcp.json" "$FAKE_CWD/mcp.json" "$FAKE_CWD/mcp_config.json" "$FAKE_HOME/.cursor/mcp.json"

# A valid config (so discovery proceeds) + a malformed one + one with no servers object.
cat > "$FAKE_CWD/.mcp.json" <<EOF
{
  "mcpServers": {
    "discover-valid": { "url": "$TEST_SERVER_URL", "headers": { "X-Test": "true" } }
  }
}
EOF
printf '!INJECTED_CONTENT not valid' > "$FAKE_CWD/mcp.json"
printf '{ "x": {} }' > "$FAKE_CWD/mcp_config.json"
_SESSIONS_CREATED+=("@discover-valid")

run_mcpc_discover connect
assert_success "discovery should succeed despite unusable configs alongside a valid one"
assert_contains "$STDOUT" "Found 3 MCP config files"
# Both unusable files are listed in place, marked (invalid) with a reason.
normalized_stdout="${STDOUT//\\//}"
assert_contains "$normalized_stdout" "mcp.json (invalid)"
assert_contains "$normalized_stdout" "mcp_config.json (invalid)"
assert_contains "$STDOUT" "No \"mcpServers\" or \"servers\" property."
# The malformed file's content must not be echoed back (layout + prompt-injection safety).
assert_not_contains "$STDOUT" "INJECTED_CONTENT"
test_pass

test_done
