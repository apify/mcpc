#!/bin/bash
# Test: connect --auto-restart recovers expired sessions automatically

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/auto-restart"

# Start test server
start_test_server

SESSION=$(session_name "auto-restart")

# Test: connect with --auto-restart stores the flag in sessions.json
test_case "connect --auto-restart stores autoRestart flag"
curl -s -X POST "$TEST_SERVER_URL/control/reset" >/dev/null

run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --auto-restart
assert_success
_SESSIONS_CREATED+=("$SESSION")

# Read sessions.json directly: `mcpc --json` consolidates sessions, which would
# kick off background restarts and race the assertions below.
auto_restart=$(jq -r ".sessions[\"$SESSION\"].autoRestart" "$MCPC_HOME_DIR/sessions.json")
if [[ "$auto_restart" != "true" ]]; then
  test_fail "expected autoRestart=true in sessions.json, got: $auto_restart"
  exit 1
fi
test_pass

# Test: capture the MCP session ID before expiry
test_case "session works and MCP session ID is stored"
run_xmcpc "$SESSION" tools-list
assert_success
old_mcp_session_id=$(jq -r ".sessions[\"$SESSION\"].mcpSessionId" "$MCPC_HOME_DIR/sessions.json")
assert_not_empty "$old_mcp_session_id" "mcpSessionId should be stored in sessions.json"
test_pass

# Test: server-side expiry still fails the in-flight command and marks the session expired
test_case "expired session marks status as expired"
curl -s -X POST "$TEST_SERVER_URL/control/expire-session" >/dev/null

# The in-flight command fails (server rejects the session); recovery happens on next use
run_mcpc "$SESSION" ping
if [[ "$EXIT_CODE" -eq 0 ]]; then
  test_fail "expected command to fail while server rejects the session"
  exit 1
fi

# The bridge marks the session as expired before shutting down (may take a moment)
for _ in $(seq 1 20); do
  session_status=$(jq -r ".sessions[\"$SESSION\"].status" "$MCPC_HOME_DIR/sessions.json")
  [[ "$session_status" == "expired" ]] && break
  sleep 0.5
done
if [[ "$session_status" != "expired" ]]; then
  test_fail "expected session status to be 'expired' but got '$session_status'"
  exit 1
fi
test_pass

# Test: next command auto-restarts the expired session with a fresh MCP session
test_case "next command auto-restarts expired session"
# Reset server state so a fresh session can be created
curl -s -X POST "$TEST_SERVER_URL/control/reset" >/dev/null

run_mcpc "$SESSION" tools-list
assert_success

session_status=$(jq -r ".sessions[\"$SESSION\"].status" "$MCPC_HOME_DIR/sessions.json")
if [[ "$session_status" != "active" ]]; then
  test_fail "expected session status to be 'active' after auto-restart but got '$session_status'"
  exit 1
fi
test_pass

# Test: the auto-restarted session is a fresh MCP session (old id discarded)
test_case "auto-restart creates a fresh MCP session"
new_mcp_session_id=$(jq -r ".sessions[\"$SESSION\"].mcpSessionId" "$MCPC_HOME_DIR/sessions.json")
assert_not_empty "$new_mcp_session_id" "new mcpSessionId should be stored after auto-restart"
if [[ "$new_mcp_session_id" == "$old_mcp_session_id" ]]; then
  test_fail "expected a fresh MCP session id after auto-restart but got the same: $new_mcp_session_id"
  exit 1
fi
echo "MCP session ID changed from $old_mcp_session_id to $new_mcp_session_id"
test_pass

# Test: probing all sessions (not using the expired one directly) also triggers
# the auto-restart in the background, consistent with crashed-session reconnection.
# This keeps commands like `mcpc grep` working without ever touching the session.
test_case "mcpc grep auto-restarts expired sessions in the background"
curl -s -X POST "$TEST_SERVER_URL/control/expire-session" >/dev/null

run_mcpc "$SESSION" ping
if [[ "$EXIT_CODE" -eq 0 ]]; then
  test_fail "expected ping to fail while server rejects the session"
  exit 1
fi
for _ in $(seq 1 20); do
  session_status=$(jq -r ".sessions[\"$SESSION\"].status" "$MCPC_HOME_DIR/sessions.json")
  [[ "$session_status" == "expired" ]] && break
  sleep 0.5
done
if [[ "$session_status" != "expired" ]]; then
  test_fail "expected session status to be 'expired' but got '$session_status'"
  exit 1
fi

# Reset server state so a fresh session can be created
curl -s -X POST "$TEST_SERVER_URL/control/reset" >/dev/null

# Probe sessions repeatedly with grep. The background restart only becomes
# eligible after the auto-restart cooldown (~10s since the bridge was last seen
# alive), so poll until the session recovers. Grep's exit code is irrelevant
# here (1 just means no matches).
recovered=""
for _ in $(seq 1 20); do
  run_mcpc grep "echo"
  session_status=$(jq -r ".sessions[\"$SESSION\"].status" "$MCPC_HOME_DIR/sessions.json")
  if [[ "$session_status" == "active" ]]; then
    recovered=1
    break
  fi
  sleep 2
done
if [[ -z "$recovered" ]]; then
  test_fail "expected mcpc grep to auto-restart the expired session, still '$session_status'"
  exit 1
fi

# The recovered session must be a fresh MCP session
grep_mcp_session_id=$(jq -r ".sessions[\"$SESSION\"].mcpSessionId" "$MCPC_HOME_DIR/sessions.json")
assert_not_empty "$grep_mcp_session_id" "mcpSessionId should be stored after background auto-restart"
if [[ "$grep_mcp_session_id" == "$new_mcp_session_id" ]]; then
  test_fail "expected a fresh MCP session id after background auto-restart but got the same: $grep_mcp_session_id"
  exit 1
fi

# The session works again without any direct restart
run_xmcpc "$SESSION" tools-list
assert_success
test_pass

test_done
