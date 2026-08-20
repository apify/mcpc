#!/bin/bash
# Test: a stale MCP-Session-Id never wedges a 2026-07-28 session
#
# Regression guard for #374. The SDK skips version negotiation whenever a session id is
# supplied, so a leftover id makes a modern connection speak without the per-request
# `_meta` envelope while the transport still stamps the MCP-Protocol-Version header —
# which every 2026-07-28 server rejects ("missing the required per-request envelope
# key(s): _meta"). Reconnecting replays the same id, so the session stays stuck
# reconnecting forever. mcpc must drop the stale id and negotiate afresh instead.
#
# How a leftover id happens in the wild: a server that used to be stateful (2025 era,
# assigning session ids) upgrades to the stateless 2026-07-28 model. The id stays in
# sessions.json while the negotiated version becomes modern.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/stale-session-id" --isolated

# The failure only exists on a 2026-07-28 connection: legacy resumption needs no envelope.
require_server_protocol modern

start_test_server

SESSION=$(session_name "stale-sid")

# Test: a modern connection is stateless — no session id of its own
test_case "modern connect records a stateless connection"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION"
assert_success
_SESSIONS_CREATED+=("$SESSION")

run_mcpc --json
stateless=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .stateless")
mcp_session_id=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .mcpSessionId")
bridge_pid=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .pid")
assert_eq "$stateless" "true" "a 2026-07-28 connection should be stateless"
assert_eq "$mcp_session_id" "null" "a stateless connection should store no mcpSessionId"
assert_not_empty "$bridge_pid" "bridge PID should be stored after connect"
test_pass

# Test: plant a leftover session id, as a server that dropped session support would leave
test_case "plant a stale mcpSessionId in sessions.json"
jq ".sessions[\"$SESSION\"].mcpSessionId = \"stale-session-id\"" \
  "$MCPC_HOME_DIR/sessions.json" > "$TEST_TMP/sessions.json"
mv "$TEST_TMP/sessions.json" "$MCPC_HOME_DIR/sessions.json"
planted=$(jq -r ".sessions[\"$SESSION\"].mcpSessionId" "$MCPC_HOME_DIR/sessions.json")
assert_eq "$planted" "stale-session-id" "stale id should be in sessions.json"
test_pass

# Test: crash the bridge so the next command has to reconnect with the stale id
test_case "crash bridge (no graceful shutdown)"
if is_windows; then
  _kill_tree "$bridge_pid"
  sleep 1
else
  kill -9 "$bridge_pid" 2>/dev/null || true
  if ! wait_for "! kill -0 $bridge_pid 2>/dev/null" 10; then
    test_fail "bridge should not be running after SIGKILL"
    exit 1
  fi
fi
test_pass

# Test: the reconnect works — the stale id must not suppress version negotiation
test_case "command works after crash despite the stale session id"
run_mcpc "$SESSION" tools-list
assert_success
assert_not_contains "$STDOUT" "envelope"
test_pass

# Test: the stale id is gone, so later reconnects start clean
test_case "stale mcpSessionId dropped from sessions.json"
stored=$(jq -r ".sessions[\"$SESSION\"].mcpSessionId // \"none\"" "$MCPC_HOME_DIR/sessions.json")
assert_eq "$stored" "none" "the stale mcpSessionId should have been cleared"
test_pass

# Test: the session is healthy again, with the modern protocol negotiated
test_case "session reports the negotiated modern protocol"
run_mcpc --json "$SESSION"
assert_success
assert_json "$STDOUT" '.protocolVersion == "2026-07-28"' \
  "the reconnect should have negotiated 2026-07-28 again"
test_pass

# Test: close session
test_case "close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
