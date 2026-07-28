#!/bin/bash
# Test: session resumption after a bridge crash preserves the negotiated protocol
# version, the server capabilities and the server instructions
#
# Regression guard: the SDK skips the initialize handshake when resuming with a
# preserved MCP-Session-Id, so the client never re-learns any of it. mcpc must
# restore the values persisted in sessions.json — otherwise session details show
# "MCP: version unknown" with no capabilities and no instructions, and requests go
# out without the required MCP-Protocol-Version header.

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

# Test: capabilities and instructions are persisted so a resumed bridge can restore them
test_case "capabilities and instructions persisted after connect"
capabilities=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .capabilities | tostring")
assert_contains "$capabilities" "tools" "capabilities should be stored after connect"
# The session list reports only whether instructions exist (they can be kilobytes),
# so read the text itself straight from sessions.json
has_instructions=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .hasInstructions")
assert_eq "$has_instructions" "true" "session list should report hasInstructions"
stored_instructions=$(jq -r ".sessions[\"$SESSION\"].instructions" "$MCPC_HOME_DIR/sessions.json")
assert_contains "$stored_instructions" "E2E test server" "instructions should be stored after connect"
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
assert_contains "$STDOUT" "MCP: version $protocol_version"
assert_not_contains "$STDOUT" "MCP: version unknown"
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

# Test: capabilities survive resumption — without them the session reports
# "(none)" and the resources-subscribe pre-check below wrongly refuses
test_case "capabilities preserved after resume"
json_capabilities=$(json_get ".capabilities | tostring")
assert_contains "$json_capabilities" "tools" "JSON capabilities should be present after resume"
run_mcpc "$SESSION"
assert_success
assert_contains "$STDOUT" "tools (" "session details should still list the tools capability"
test_pass

# Test: instructions survive resumption (shown in session details, searched by `grep`)
test_case "instructions preserved after resume"
assert_contains "$STDOUT" "E2E test server" "session details should still show instructions"
run_mcpc --json "$SESSION" grep "E2E test server" --instructions
assert_success
assert_json "$STDOUT" '.sessions[0].instructions | type == "string"' \
  "grep should still match the server instructions after resume"
test_pass

# Test: the resources.subscribe capability check accepts a resumed session
test_case "resources-subscribe works after resume"
subscribe_uri="test://dynamic/counter"
run_mcpc "$SESSION" resources-subscribe "$subscribe_uri" "$TEST_TMP/resume-sync.txt"
assert_success
assert_not_contains "$STDOUT" "does not support resource subscriptions"
run_mcpc "$SESSION" resources-unsubscribe "$subscribe_uri"
assert_success
test_pass

# Test: close session
test_case "close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
