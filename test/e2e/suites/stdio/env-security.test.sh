#!/bin/bash
# Test: stdio env security (no leak in process list, sessions.json, or --json output)
# A config entry's `env` routinely holds API tokens — directly or via ${VAR}
# substitution — so its values get the same treatment as HTTP headers: keychain
# storage, IPC delivery to the bridge, and "<redacted>" everywhere else (#341).

source "$(dirname "$0")/../../lib/framework.sh"
test_init "stdio/env-security" --isolated

# The secret is injected into the config via ${FAKE_SECRET_TOKEN} substitution,
# exactly like the report in #341.
export FAKE_SECRET_TOKEN="sk-stdio-env-secret-$(date +%s)"

STDIO_SERVER="$(to_native_path "$PROJECT_ROOT/test/e2e/server/stdio-server.mjs")"
CONFIG_FILE="$(to_native_path "$TEST_TMP/env-security-config.json")"
cat > "$CONFIG_FILE" <<EOF
{
  "mcpServers": {
    "env-secret": {
      "command": "node",
      "args": ["$STDIO_SERVER"],
      "env": {
        "SECRET_TOKEN": "\${FAKE_SECRET_TOKEN}",
        "PUBLIC_SETTING": "not-a-secret"
      }
    }
  }
}
EOF

SESSION=$(session_name "env-sec")

# =============================================================================
# Test: session connects and the env values reach the server process
# =============================================================================

test_case "stdio session with env connects"
run_mcpc connect "$CONFIG_FILE:env-secret" "$SESSION"
assert_success
_SESSIONS_CREATED+=("$SESSION")
wait_for "$MCPC $SESSION ping >/dev/null 2>&1"
test_pass

test_case "env values still reach the stdio server process"
run_mcpc "$SESSION" tools-call echo-env "name:=SECRET_TOKEN"
assert_success
assert_contains "$STDOUT" "$FAKE_SECRET_TOKEN"
test_pass

# =============================================================================
# Test: the secret is not exposed anywhere it can be read back
# =============================================================================

test_case "secret env value not visible in ps output"
ps_output=$(ps aux 2>/dev/null || ps -ef 2>/dev/null || echo "")
if echo "$ps_output" | grep -q "$FAKE_SECRET_TOKEN"; then
  test_fail "Secret env value found in the process list! It must be sent over IPC, not argv."
fi
test_pass

test_case "env values are redacted in sessions.json"
sessions_file="$MCPC_HOME_DIR/sessions.json"
assert_file_exists "$sessions_file"
sessions_content=$(cat "$sessions_file")

if echo "$sessions_content" | grep -q "$FAKE_SECRET_TOKEN"; then
  test_fail "Secret env value found in sessions.json! Env values must be redacted."
fi

# The key names are kept (they are needed on restart), the values are not
stored_env=$(jq -r ".sessions[\"$SESSION\"].server.env.SECRET_TOKEN" "$sessions_file")
if [[ "$stored_env" != "<redacted>" ]]; then
  test_fail "Expected <redacted> for env.SECRET_TOKEN in sessions.json, got: $stored_env"
fi
test_pass

test_case "session info --json redacts env values"
run_mcpc --json "$SESSION"
assert_success
assert_json_valid "$STDOUT"
if echo "$STDOUT" | grep -q "$FAKE_SECRET_TOKEN"; then
  test_fail "Secret env value found in 'mcpc --json @session' output!"
fi
json_env=$(json_get "._mcpc.server.env.SECRET_TOKEN")
if [[ "$json_env" != "<redacted>" ]]; then
  test_fail "Expected <redacted> for _mcpc.server.env.SECRET_TOKEN, got: $json_env"
fi
test_pass

test_case "session list --json redacts env values"
run_mcpc --json
assert_success
assert_json_valid "$STDOUT"
if echo "$STDOUT" | grep -q "$FAKE_SECRET_TOKEN"; then
  test_fail "Secret env value found in 'mcpc --json' session list!"
fi
test_pass

test_case "bridge log doesn't leak env values"
BRIDGE_LOG="$MCPC_HOME_DIR/logs/bridge-$SESSION.log"
if [[ -f "$BRIDGE_LOG" ]]; then
  if grep -q "$FAKE_SECRET_TOKEN" "$BRIDGE_LOG"; then
    test_fail "Secret env value found in the bridge log!"
  fi
fi
test_pass

test_case "verbose output doesn't leak env values"
run_mcpc --verbose "$SESSION" ping
assert_success
if echo "$STDOUT$STDERR" | grep -q "$FAKE_SECRET_TOKEN"; then
  test_fail "Secret env value found in verbose output!"
fi
test_pass

# =============================================================================
# Test: env survives a restart (restored from the keychain, not sessions.json)
# =============================================================================

test_case "env values survive an explicit restart"
run_mcpc "$SESSION" restart
assert_success
wait_for "$MCPC $SESSION ping >/dev/null 2>&1"

run_mcpc "$SESSION" tools-call echo-env "name:=SECRET_TOKEN"
assert_success
assert_contains "$STDOUT" "$FAKE_SECRET_TOKEN"
test_pass

test_case "env values survive a bridge crash"
run_mcpc --json
bridge_pid=$(json_get ".sessions[] | select(.name == \"$SESSION\") | .pid")
if [[ -n "$bridge_pid" && "$bridge_pid" != "null" ]]; then
  _kill_tree "$bridge_pid"
  wait_for "! kill -0 $bridge_pid 2>/dev/null" 10 || true

  run_mcpc "$SESSION" tools-call echo-env "name:=SECRET_TOKEN"
  assert_success
  assert_contains "$STDOUT" "$FAKE_SECRET_TOKEN"
fi
test_pass

test_case "cleanup: close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

# =============================================================================
# Test: a session written before env was a secret (plaintext values in
#       sessions.json) keeps working — the upgrade never breaks it
# =============================================================================

test_case "legacy session with plaintext env still works after restart"
LEGACY_SESSION=$(session_name "env-old")
LEGACY_SECRET="sk-legacy-env-secret-$(date +%s)"

run_mcpc connect "$CONFIG_FILE:env-secret" "$LEGACY_SESSION"
assert_success
_SESSIONS_CREATED+=("$LEGACY_SESSION")
wait_for "$MCPC $LEGACY_SESSION ping >/dev/null 2>&1"

# Simulate the pre-fix on-disk state: plaintext env values in sessions.json.
# The keychain entry is left in place but overridden by the plaintext copy,
# which is what an upgraded session looks like from the CLI's point of view.
sessions_file="$MCPC_HOME_DIR/sessions.json"
tmp_sessions="$TEST_TMP/sessions-legacy.json"
jq --arg s "$LEGACY_SESSION" --arg v "$LEGACY_SECRET" \
  '.sessions[$s].server.env.SECRET_TOKEN = $v' "$sessions_file" > "$tmp_sessions"
mv "$tmp_sessions" "$sessions_file"

run_mcpc "$LEGACY_SESSION" restart
assert_success
wait_for "$MCPC $LEGACY_SESSION ping >/dev/null 2>&1"

# The plaintext value is honoured (not dropped, not passed through as "<redacted>")
run_mcpc "$LEGACY_SESSION" tools-call echo-env "name:=SECRET_TOKEN"
assert_success
assert_contains "$STDOUT" "$LEGACY_SECRET"
test_pass

test_case "cleanup: close legacy session"
run_mcpc "$LEGACY_SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$LEGACY_SESSION}")
test_pass

unset FAKE_SECRET_TOKEN
test_done
