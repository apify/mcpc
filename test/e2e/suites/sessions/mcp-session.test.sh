#!/bin/bash
# Test: MCP session ID behavior (connection management)

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/mcp-session"

# MCP session IDs (and their expiry/DELETE lifecycle) exist only in the
# 2025-era protocol; 2026-07-28 connections are stateless.
require_server_protocol legacy

# Start test server
start_test_server

# Generate unique session name
SESSION=$(session_name "mcp-session")

# Test: new session creates MCP session on server
test_case "new session creates MCP session on server"
# Reset server state
curl -s -X POST "$TEST_SERVER_URL/control/reset" >/dev/null

# Check no active sessions initially (or known count)
initial_sessions=$(curl -s "$TEST_SERVER_URL/control/get-active-sessions" | jq '.activeSessions | length')

# Create mcpc session
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")

# Use the session to trigger MCP initialization
run_xmcpc "$SESSION" tools-list
assert_success

# Verify server has a new active MCP session
current_sessions=$(curl -s "$TEST_SERVER_URL/control/get-active-sessions" | jq '.activeSessions | length')
if [[ "$current_sessions" -le "$initial_sessions" ]]; then
  test_fail "expected new MCP session on server (had $initial_sessions, now have $current_sessions)"
  exit 1
fi
test_pass

# Test: get the MCP session ID
test_case "capture MCP session ID"
mcp_session_ids=$(curl -s "$TEST_SERVER_URL/control/get-active-sessions" | jq -r '.activeSessions[]')
# There should be at least one session
assert_not_empty "$mcp_session_ids" "should have at least one MCP session"
test_pass

# Test: MCP session ID is stored in sessions.json
test_case "MCP session ID persists in sessions.json"
run_mcpc --json
stored_mcp_session_id=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .mcpSessionId")
assert_not_empty "$stored_mcp_session_id" "mcpSessionId should be stored in sessions.json"
# Verify it matches one of the active sessions on server
if ! echo "$mcp_session_ids" | grep -q "$stored_mcp_session_id"; then
  test_fail "stored mcpSessionId ($stored_mcp_session_id) not found in server's active sessions"
  exit 1
fi
test_pass

# Test: bridge restart with rejected session ID marks session as expired
test_case "rejected session ID marks session as expired"

# Use run_mcpc (not run_xmcpc) because session list can change between
# the 4 variant calls when other tests run in parallel with shared home
run_mcpc --json
bridge_pid=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .pid")
assert_not_empty "$bridge_pid" "should have bridge PID"

# Kill the bridge
_kill_tree "$bridge_pid"
sleep 1

# On Windows, force-kill doesn't allow graceful shutdown (no HTTP DELETE),
# so the server still has the session active. Expire it via control API.
if is_windows; then
  curl -s -X POST "$TEST_SERVER_URL/control/expire-session" >/dev/null
fi

# Use session again - server should reject the old session ID
# and bridge should mark session as expired (NOT auto-reconnect)
run_xmcpc "$SESSION" tools-list
# This should FAIL because session is marked as expired
if [[ "$EXIT_CODE" -eq 0 ]]; then
  test_fail "expected command to fail when session ID is rejected"
  exit 1
fi

# Verify session is marked as expired
run_mcpc --json
session_status=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .status")
if [[ "$session_status" != "expired" ]]; then
  test_fail "expected session status to be 'expired' but got '$session_status'"
  exit 1
fi
test_pass

# Test: explicit restart creates new session
test_case "explicit restart recovers from expired session"
# Reset server state so the restarted bridge can connect
if is_windows; then
  curl -s -X POST "$TEST_SERVER_URL/control/reset" >/dev/null
fi
run_mcpc "$SESSION" restart
assert_success

# Verify session is now live
run_mcpc --json
session_status=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .status")
if [[ "$session_status" != "live" ]]; then
  test_fail "expected session status to be 'live' after restart but got '$session_status'"
  exit 1
fi

# Commands should work again
run_xmcpc "$SESSION" tools-list
assert_success
test_pass

# Test: new session ID is stored after explicit restart
test_case "new MCP session ID stored after explicit restart"
run_mcpc --json
new_stored_mcp_session_id=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .mcpSessionId")
assert_not_empty "$new_stored_mcp_session_id" "new mcpSessionId should be stored after restart"
# The new session ID should be different from the old one
if [[ "$new_stored_mcp_session_id" == "$stored_mcp_session_id" ]]; then
  test_fail "expected different session ID after restart but got same: $new_stored_mcp_session_id"
  exit 1
fi
echo "MCP session ID changed from $stored_mcp_session_id to $new_stored_mcp_session_id"
test_pass

# Test: graceful close removes MCP session
test_case "graceful close removes MCP session from server"

# Count current sessions
before_close=$(curl -s "$TEST_SERVER_URL/control/get-active-sessions" | jq '.activeSessions | length')

# Close the session
run_mcpc "$SESSION" close
assert_success

# Give server a moment to process
sleep 0.5

# Count after close
after_close=$(curl -s "$TEST_SERVER_URL/control/get-active-sessions" | jq '.activeSessions | length')

# Should have fewer active sessions (our session was removed)
if [[ "$after_close" -ge "$before_close" ]]; then
  # This is OK if server doesn't support DELETE, just note it
  echo "Note: Server session count unchanged after close (before=$before_close, after=$after_close)"
fi

# Verify DELETE was sent
deleted=$(curl -s "$TEST_SERVER_URL/control/get-deleted-sessions" | jq '.deletedSessions | length')
if [[ "$deleted" -lt 1 ]]; then
  test_fail "expected DELETE to be sent on close"
  exit 1
fi
test_pass

# Remove from cleanup list since we closed it
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")

test_done
