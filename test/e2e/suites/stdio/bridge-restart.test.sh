#!/bin/bash
# Test: Bridge restart for stdio transport
# Verifies that when a bridge process is killed, mcpc automatically restarts it
# with the correct command arguments (including stdioArgs)

source "$(dirname "$0")/../../lib/framework.sh"
test_init "stdio/bridge-restart"

# Create a config file for the filesystem server
CONFIG=$(create_fs_config "$TEST_TMP")

# Generate unique session name
SESSION=$(session_name "restart")

# Test: create session with stdio config
test_case "create session with stdio config"
run_mcpc connect "$CONFIG:fs" "$SESSION"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

# Test: verify session works initially
test_case "session works initially"
run_xmcpc "$SESSION" tools-list
assert_success
assert_contains "$STDOUT" "read_file"
test_pass

# Test: capture bridge PID
# Note: Use run_mcpc because session list is non-deterministic in parallel tests
test_case "capture bridge PID"
run_mcpc --json
original_pid=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .pid")
assert_not_empty "$original_pid" "should have bridge PID"
test_pass

# Test: verify bridge process is running
test_case "verify bridge process is running"
if ! process_is_running "$original_pid"; then
  test_fail "bridge process should be running"
  exit 1
fi
test_pass

# Test: kill the bridge process
test_case "kill bridge process"
_kill_tree "$original_pid"
# Wait for the process to actually die. The SIGTERM shutdown is graceful (the
# stdio child gets close-stdin → SIGTERM → SIGKILL escalation with timeouts),
# so poll rather than using a fixed sleep — 1s is flaky on slow machines.
if ! wait_for_process_exit "$original_pid"; then
  test_fail "bridge process should have been killed"
  exit 1
fi
test_pass

# Test: session auto-restarts bridge and works
test_case "session auto-restarts bridge and works"
# This is the key test - after killing the bridge, using the session should:
# 1. Detect the crashed bridge
# 2. Restart it with the correct command + args (including stdioArgs)
# 3. Successfully complete the command
run_xmcpc "$SESSION" tools-list
assert_success
assert_contains "$STDOUT" "read_file"
test_pass

# Test: verify new PID is different
test_case "bridge has new PID after restart"
run_mcpc --json
new_pid=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .pid")
assert_not_empty "$new_pid" "should have new bridge PID"
if [[ "$new_pid" == "$original_pid" ]]; then
  test_fail "new PID ($new_pid) should be different from original ($original_pid)"
  exit 1
fi
test_pass

# Test: create a test file and read it via restarted session
test_case "file operations work after restart"
echo "Content after restart test" > "$TEST_TMP/restart-test.txt"
run_xmcpc "$SESSION" tools-call read_file "path:=$NATIVE_TEST_TMP/restart-test.txt"
assert_success
assert_contains "$STDOUT" "Content after restart test"
test_pass

# Test: kill bridge again and verify it restarts again
test_case "bridge restarts multiple times"
run_mcpc --json
second_pid=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .pid")
_kill_tree "$second_pid"
sleep 1

# Use session again - should restart
run_xmcpc "$SESSION" tools-list
assert_success
assert_contains "$STDOUT" "read_file"

# Verify PID changed again
run_mcpc --json
third_pid=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .pid")
if [[ "$third_pid" == "$second_pid" ]]; then
  test_fail "third PID ($third_pid) should be different from second ($second_pid)"
  exit 1
fi
test_pass

# Test: close session
test_case "close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
