#!/bin/bash
# Test: session resumption after a bridge crash preserves the negotiated protocol version
#
# Regression guard: the SDK skips the initialize handshake when resuming with a
# preserved MCP-Session-Id, so the client never re-learns the protocol version.
# mcpc must seed the reconnected transport with the version persisted in
# sessions.json — otherwise session details show "Protocol: unknown" and requests
# go out without the required MCP-Protocol-Version header.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/resume"

# MCP session IDs (and thus resumption) exist only in the 2025-era protocol;
# 2026-07-28 connections are stateless.
require_server_protocol legacy

# Start test server
start_test_server

SESSION=$(session_name "resume")

# Test: create session and capture negotiated protocol state
test_case "create session and capture protocol state"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION"
assert_success
_SESSIONS_CREATED+=("$SESSION")

run_mcpc --json
protocol_version=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .protocolVersion")
mcp_session_id=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .mcpSessionId")
bridge_pid=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .pid")
assert_not_empty "$protocol_version" "protocolVersion should be stored after connect"
assert_not_empty "$mcp_session_id" "mcpSessionId should be stored after connect"
assert_not_empty "$bridge_pid" "bridge PID should be stored after connect"
test_pass

# Test: crash the bridge without graceful shutdown (no HTTP DELETE, so the
# server keeps the MCP session alive and the restarted bridge can resume it)
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

# Test: next command auto-restarts the bridge and resumes the MCP session
test_case "command works after crash (auto-restart resumes session)"
run_mcpc "$SESSION" ping
assert_success
test_pass

# Test: the session was resumed, not re-initialized
test_case "same MCP session ID after resume"
run_mcpc --json
resumed_session_id=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .mcpSessionId")
assert_eq "$resumed_session_id" "$mcp_session_id" "mcpSessionId should be unchanged after resume"
test_pass

# Test: protocol version survives resumption (SDK skips the handshake, so mcpc
# must restore the persisted version)
test_case "protocol version preserved after resume"
run_mcpc "$SESSION"
assert_success
assert_contains "$STDOUT" "Protocol: $protocol_version"
assert_not_contains "$STDOUT" "Protocol: unknown"
test_pass

# Test: server info is still shown in session details after resume
test_case "server info preserved after resume"
assert_contains "$STDOUT" "Server:"
run_mcpc --json "$SESSION"
assert_success
json_protocol=$(json_get ".protocolVersion")
json_server_name=$(json_get ".serverInfo.name")
assert_eq "$json_protocol" "$protocol_version" "JSON protocolVersion should match original"
assert_not_empty "$json_server_name" "JSON serverInfo.name should be present after resume"
test_pass

# Test: close session
test_case "close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
