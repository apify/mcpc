#!/bin/bash
# Test: a stale MCP-Session-Id never wedges a 2026-07-28 session
#
# Regression guard for #374. The SDK skips version negotiation whenever a session id is
# supplied, so a leftover id makes a modern connection speak without the per-request
# `_meta` envelope while the transport still stamps the MCP-Protocol-Version header —
# which every 2026-07-28 server rejects ("missing the required per-request envelope
# key(s): _meta"). Reconnecting replays the same id, so the session used to stay stuck
# reconnecting forever.
#
# Two scenarios, both from a server upgrading under a stored session:
#   1. id stored with a modern protocol version → resumption is impossible by definition,
#      mcpc ignores the id and negotiates afresh (self-heals)
#   2. id stored with a legacy protocol version, server no longer speaks it → the session
#      is marked expired with a clear error, and `restart` recovers it

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

# Plants fields into the session record and SIGKILLs the bridge, so the next command
# has to reconnect from the doctored sessions.json.
plant_and_crash() {
  local jq_expr="$1"
  jq "$jq_expr" "$MCPC_HOME_DIR/sessions.json" > "$TEST_TMP/sessions.json"
  mv "$TEST_TMP/sessions.json" "$MCPC_HOME_DIR/sessions.json"
  run_mcpc --json
  bridge_pid=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .pid")
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
}

# Test: an id stored with a modern protocol version is ignored — the reconnect
# negotiates afresh instead of replaying an id that suppresses negotiation
test_case "reconnect ignores a session id stored with a modern protocol version"
plant_and_crash ".sessions[\"$SESSION\"].mcpSessionId = \"stale-session-id\""
run_mcpc "$SESSION" tools-list
assert_success
assert_not_contains "$STDOUT" "envelope"
test_pass

# Test: the stale id is gone, so later reconnects start clean
test_case "stale mcpSessionId dropped from sessions.json"
stored=$(jq -r ".sessions[\"$SESSION\"].mcpSessionId // \"none\"" "$MCPC_HOME_DIR/sessions.json")
assert_eq "$stored" "none" "the stale mcpSessionId should have been cleared"
run_mcpc --json "$SESSION"
assert_success
assert_json "$STDOUT" '.protocolVersion == "2026-07-28"' \
  "the reconnect should have negotiated 2026-07-28 again"
test_pass

# Test: a legacy-era session id against a server that no longer speaks that protocol
# fails gracefully — marked expired with a clear error, not a reconnect loop
test_case "legacy session against an upgraded server is marked expired"
plant_and_crash "
  .sessions[\"$SESSION\"].mcpSessionId = \"stale-session-id\" |
  .sessions[\"$SESSION\"].protocolVersion = \"2025-11-25\""
run_mcpc "$SESSION" tools-list
assert_failure
assert_contains "$STDERR" "expired" "the error should say the session expired"
assert_contains "$STDERR" "restart" "the error should point at the restart command"
run_mcpc --json
session_status=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .status")
assert_eq "$session_status" "expired" "the session should be marked expired"
test_pass

# Test: restart recovers the expired session with a fresh negotiation
test_case "restart recovers the expired session"
run_mcpc "$SESSION" restart
assert_success
run_mcpc --json "$SESSION"
assert_success
assert_json "$STDOUT" '.protocolVersion == "2026-07-28"' \
  "restart should have negotiated 2026-07-28 again"
test_pass

# Test: close session
test_case "close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
