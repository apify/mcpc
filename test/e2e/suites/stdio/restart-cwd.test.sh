#!/bin/bash
# Test: A stdio server is always restarted in the directory its session was connected from
#
# The bridge of a stdio session is restarted by whichever mcpc command first notices it is
# gone, and a command like `node server.mjs` runs whatever the directory it starts in holds.
# The session therefore records its working directory at connect time, and every restart
# uses it — never the directory the restarting command happens to run in.
#
# Covered scenarios:
#  1. The connect-time directory is recorded in the session
#  2. An implicit restart from another directory runs the original server, not the other
#     directory's script of the same name
#  3. A background reconnect (bare `mcpc`) from another directory does the same
#  4. A session with no recorded directory (created by an older mcpc) is not restarted
#     automatically; an explicit `restart` records the current directory
#  5. A recorded directory that no longer exists is reported, not replaced

source "$(dirname "$0")/../../lib/framework.sh"
test_init "stdio/restart-cwd"

PROJECT_DIR="$TEST_TMP/project"
OTHER_DIR="$TEST_TMP/other"
MARKER_FILE="$TEST_TMP/other-server-ran.txt"
mkdir -p "$PROJECT_DIR" "$OTHER_DIR"

# A minimal MCP stdio server exposing one tool whose name says which copy is running.
# With a second argument it also leaves a marker file, so "the other directory's copy ran"
# is detectable even if the server then fails to answer.
write_server() {
  local dir="$1" tool="$2" marker="${3:-}"
  local marker_json
  marker_json=$(node -e 'console.log(JSON.stringify(process.argv[1] || ""))' "$marker")
  cat > "$dir/server.mjs" <<EOF
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const marker = $marker_json;
if (marker) writeFileSync(marker, process.cwd());
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
  if (msg.method === 'initialize') {
    return reply({
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: '$tool', version: '1.0.0' },
    });
  }
  if (msg.method === 'ping') return reply({});
  if (msg.method === 'tools/list') {
    return reply({ tools: [{ name: '$tool', inputSchema: { type: 'object' } }] });
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
});
EOF
}

write_server "$PROJECT_DIR" "from-project"
write_server "$OTHER_DIR" "from-other" "$MARKER_FILE"

# The entry names its script by a relative path, as project configs usually do.
cat > "$PROJECT_DIR/mcp.json" <<EOF
{ "mcpServers": { "local": { "command": "node", "args": ["server.mjs"] } } }
EOF

SESSION=$(session_name "cwd")

# Run mcpc from a given directory (run_mcpc captures into shell variables, so no subshell).
run_mcpc_in() {
  local dir="$1"
  shift
  pushd "$dir" >/dev/null
  run_mcpc "$@"
  popd >/dev/null
}

session_field() {
  run_mcpc --json
  json_get ".sessions[] | select(.name == \"$SESSION\") | $1"
}

kill_bridge() {
  local pid
  pid=$(session_field ".pid")
  assert_not_empty "$pid" "session should have a bridge PID"
  _kill_tree "$pid"
  if ! wait_for_process_exit "$pid"; then
    test_fail "bridge process should have been killed"
    exit 1
  fi
}

# =============================================================================
test_case "connect records the directory the session was created in"
run_mcpc_in "$PROJECT_DIR" connect "./mcp.json:local" "$SESSION"
assert_success
_SESSIONS_CREATED+=("$SESSION")
recorded_cwd=$(session_field ".cwd")
assert_not_empty "$recorded_cwd" "a stdio session should record its working directory"
assert_contains "$recorded_cwd" "project"
run_mcpc "$SESSION" tools-list
assert_success
assert_contains "$STDOUT" "from-project"
test_pass

# =============================================================================
test_case "implicit restart from another directory runs the original server"
kill_bridge
run_mcpc_in "$OTHER_DIR" "$SESSION" tools-list
assert_success
assert_contains "$STDOUT" "from-project"
assert_not_contains "$STDOUT" "from-other"
assert_file_not_exists "$MARKER_FILE"
test_pass

# =============================================================================
test_case "background reconnect (bare mcpc) from another directory runs the original server"
old_pid=$(session_field ".pid")
kill_bridge
# Backdate the timestamps so the reconnect cooldown does not delay the background restart.
edit_sessions_json --arg s "$SESSION" \
  '.sessions[$s].lastSeenAt = "2026-01-01T00:00:00.000Z"
   | .sessions[$s].lastConnectionAttemptAt = "2026-01-01T00:00:00.000Z"'
run_mcpc_in "$OTHER_DIR"
assert_success
# The first listing marks the bridge as crashed; the reconnect is started by a listing that
# finds the session already crashed, so list until a new bridge is registered.
bridge_restarted() {
  run_mcpc_in "$OTHER_DIR"
  local pid
  pid=$(session_field ".pid")
  [[ -n "$pid" && "$pid" != "null" && "$pid" != "$old_pid" ]]
}
if ! wait_for bridge_restarted 30; then
  test_fail "bare mcpc should have reconnected the crashed session in the background"
  exit 1
fi
run_mcpc_in "$OTHER_DIR" "$SESSION" tools-list
assert_success
assert_contains "$STDOUT" "from-project"
assert_file_not_exists "$MARKER_FILE"
test_pass

# =============================================================================
test_case "session without a recorded directory is not restarted automatically"
kill_bridge
edit_sessions_json --arg s "$SESSION" \
  'del(.sessions[$s].cwd)
   | .sessions[$s].lastSeenAt = "2026-01-01T00:00:00.000Z"
   | .sessions[$s].lastConnectionAttemptAt = "2026-01-01T00:00:00.000Z"'
# Neither the listing (background reconnect) nor a command (implicit restart) may start it.
run_mcpc_in "$OTHER_DIR"
assert_success
run_mcpc_in "$OTHER_DIR"
assert_success
run_mcpc_in "$OTHER_DIR" "$SESSION" tools-list
assert_failure
assert_contains "$STDERR" "no recorded working directory"
assert_contains "$STDERR" "mcpc $SESSION restart"
assert_file_not_exists "$MARKER_FILE"
test_pass

# =============================================================================
test_case "explicit restart records the current directory for such a session"
run_mcpc_in "$PROJECT_DIR" "$SESSION" restart
assert_success
recorded_cwd=$(session_field ".cwd")
assert_contains "$recorded_cwd" "project"
kill_bridge
run_mcpc_in "$OTHER_DIR" "$SESSION" tools-list
assert_success
assert_contains "$STDOUT" "from-project"
assert_file_not_exists "$MARKER_FILE"
test_pass

# =============================================================================
test_case "a recorded directory that no longer exists is reported, not replaced"
kill_bridge
mv "$PROJECT_DIR" "$TEST_TMP/project-moved"
run_mcpc_in "$OTHER_DIR" "$SESSION" tools-list
assert_failure
assert_contains "$STDERR" "no longer exists"
assert_contains "$STDERR" "mcpc $SESSION close"
assert_file_not_exists "$MARKER_FILE"
mv "$TEST_TMP/project-moved" "$PROJECT_DIR"
test_pass

# =============================================================================
test_case "close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
