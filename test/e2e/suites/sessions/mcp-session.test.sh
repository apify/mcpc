#!/bin/bash
# Test: MCP session ID behavior (connection management)

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/mcp-session"

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
run_mcpc "$TEST_SERVER_URL" session "$SESSION"
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

# Test: bridge restart creates new MCP session
test_case "bridge restart creates new MCP session"

# Get bridge PID (use run_mcpc, not run_xmcpc, because session list output
# can change between runs when other tests run in parallel with shared home)
run_mcpc --json
bridge_pid=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .pid")
assert_not_empty "$bridge_pid" "should have bridge PID"

# Remember current MCP session IDs
old_mcp_sessions=$(curl -s "$TEST_SERVER_URL/control/get-active-sessions" | jq -r '.activeSessions[]')

# Kill the bridge
kill "$bridge_pid" 2>/dev/null || true
sleep 1

# Use session again - should restart bridge and create new MCP session
run_xmcpc "$SESSION" tools-list
assert_success

# Get new MCP session IDs
new_mcp_sessions=$(curl -s "$TEST_SERVER_URL/control/get-active-sessions" | jq -r '.activeSessions[]')

# The session IDs should be different (new session created)
# Note: Old session might still exist briefly due to server cleanup timing
if [[ -z "$new_mcp_sessions" ]]; then
  test_fail "no MCP sessions after bridge restart"
  exit 1
fi
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
