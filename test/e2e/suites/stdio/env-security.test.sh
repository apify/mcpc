#!/bin/bash
# Test: stdio `env` security (no leak in process list, logs, or storage)
# A config entry's `env` is where stdio servers get their API tokens. The values must
# reach the server process and nothing else: not the bridge's argv (`ps`), not
# sessions.json, not `mcpc --json`, not verbose output, not the bridge log — and they
# must survive a bridge restart (restored from the keychain).

source "$(dirname "$0")/../../lib/framework.sh"
test_init "stdio/env-security" --isolated

# Local stdio MCP server with an `env` tool that echoes one of its environment variables.
# Native path so Windows' node can resolve it (#258).
STDIO_SERVER="$(to_native_path "$PROJECT_ROOT/test/e2e/server/stdio-server.mjs")"

SECRET_VALUE="stdio-env-secret-$(date +%s)-$$"
SECRET_NAME="E2E_API_TOKEN"

CONFIG_FILE="$(to_native_path "$TEST_TMP/env-config.json")"
cat > "$CONFIG_FILE" <<JSON
{
  "mcpServers": {
    "env-echo": {
      "command": "node",
      "args": ["$STDIO_SERVER"],
      "env": {
        "$SECRET_NAME": "$SECRET_VALUE",
        "E2E_PUBLIC": "public-value"
      }
    }
  }
}
JSON

SESSION=$(session_name "env-sec")
sessions_file="$MCPC_HOME_DIR/sessions.json"

# =============================================================================
# Test: the env reaches the server (and verbose connect output does not leak it)
# =============================================================================

test_case "verbose connect does not print the env value"
run_mcpc --verbose connect "$CONFIG_FILE:env-echo" "$SESSION"
assert_success
_SESSIONS_CREATED+=("$SESSION")
if echo "$STDOUT$STDERR" | grep -q "$SECRET_VALUE"; then
  test_fail "stdio env value found in verbose connect output!"
fi
test_pass

test_case "env value reaches the stdio server"
run_mcpc "$SESSION" tools-call env name:="$SECRET_NAME"
assert_success
assert_contains "$STDOUT" "$SECRET_VALUE"
test_pass

# =============================================================================
# Test: the env value is not in the bridge's command line
# =============================================================================

test_case "env value not visible in ps"
ps_output=$(ps aux 2>/dev/null || ps -ef 2>/dev/null || echo "")
if echo "$ps_output" | grep -v grep | grep -q "$SECRET_VALUE"; then
  test_fail "stdio env value found in process list! It must travel over IPC, not argv."
fi
# The variable name may legitimately appear (sessions.json keeps names); only the value matters.
test_pass

# =============================================================================
# Test: sessions.json and the session views keep the name but redact the value
# =============================================================================

test_case "env value redacted in sessions.json"
assert_file_exists "$sessions_file"
if grep -q "$SECRET_VALUE" "$sessions_file"; then
  test_fail "stdio env value found in sessions.json! It must be redacted."
fi
stored=$(jq -r ".sessions[\"$SESSION\"].server.env[\"$SECRET_NAME\"] // empty" "$sessions_file")
assert_eq "<redacted>" "$stored" "env value in sessions.json should be the redaction sentinel"
test_pass

test_case "mcpc --json session list does not expose the env value"
run_mcpc --json
assert_success
assert_json_valid "$STDOUT"
if echo "$STDOUT" | grep -q "$SECRET_VALUE"; then
  test_fail "stdio env value found in mcpc --json output!"
fi
listed=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$SESSION\") | .server.env[\"$SECRET_NAME\"] // empty")
assert_eq "<redacted>" "$listed" "env value in --json session list should be redacted"
test_pass

test_case "mcpc @session (human and --json) does not expose the env value"
run_mcpc "$SESSION"
assert_success
if echo "$STDOUT$STDERR" | grep -q "$SECRET_VALUE"; then
  test_fail "stdio env value found in session info output!"
fi
run_mcpc --json "$SESSION"
assert_success
if echo "$STDOUT" | grep -q "$SECRET_VALUE"; then
  test_fail "stdio env value found in session info --json output!"
fi
test_pass

# =============================================================================
# Test: the bridge log never records the value
# =============================================================================

test_case "bridge log does not contain the env value"
run_mcpc --verbose "$SESSION" tools-call env name:="$SECRET_NAME"
assert_success
BRIDGE_LOG="$MCPC_HOME_DIR/logs/bridge-$SESSION.log"
assert_file_exists "$BRIDGE_LOG"
# The tool result legitimately carries the value back to the caller; the bridge logs
# argument keys only, and the arguments themselves name the variable, not the value.
if grep -v "tools-call\|tools/call" "$BRIDGE_LOG" | grep -q "\"$SECRET_NAME\": *\"$SECRET_VALUE\""; then
  test_fail "stdio env value found as a variable assignment in the bridge log!"
fi
if grep -q "Command: .*$SECRET_VALUE" "$BRIDGE_LOG"; then
  test_fail "stdio env value found in the bridge log's command banner!"
fi
test_pass

# =============================================================================
# Test: the env is restored from the keychain after a bridge restart
# =============================================================================

test_case "env survives an explicit restart"
run_mcpc "$SESSION" restart
assert_success
run_mcpc "$SESSION" tools-call env name:="$SECRET_NAME"
assert_success
assert_contains "$STDOUT" "$SECRET_VALUE"
test_pass

test_case "env survives an automatic restart after a bridge crash"
run_mcpc --json
bridge_pid=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .pid")
assert_not_empty "$bridge_pid" "should have a bridge PID"
kill "$bridge_pid" 2>/dev/null || true
wait_for "! process_is_running $bridge_pid" 10
run_mcpc "$SESSION" tools-call env name:="$SECRET_NAME"
assert_success
assert_contains "$STDOUT" "$SECRET_VALUE"
# Still redacted after the restart rewrote the record
if grep -q "$SECRET_VALUE" "$sessions_file"; then
  test_fail "stdio env value found in sessions.json after restart!"
fi
test_pass

# =============================================================================
# Cleanup
# =============================================================================

test_case "cleanup: close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
