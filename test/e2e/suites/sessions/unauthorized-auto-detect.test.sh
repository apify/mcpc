#!/bin/bash
# Test: A crashed bearer-token session whose bridge gets a 401 on auto-reconnect
# is automatically promoted to 'unauthorized' without the user having to access
# the session first.
#
# Regression: previously, `mcpc` (the listing command) only fired-and-forgot
# the auto-restart and showed 'connecting' indefinitely until the user ran a
# command on the session, which would explicitly trigger ensureBridgeReady() and
# only then surface the auth error. The fix ensures the bridge's own status
# update (status: 'unauthorized') propagates so subsequent `mcpc` calls reflect
# reality without explicit interaction.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/unauthorized-auto-detect" --isolated

start_test_server REQUIRE_AUTH=true

SESSION=$(session_name "auto-detect")
_SESSIONS_CREATED+=("$SESSION")

# =============================================================================
# Setup: produce a session in 'crashed' state with bad bearer
#
# We can't just `mcpc connect` with a bad bearer because that produces an
# 'unauthorized' status directly (showServerDetails surfaces the error during
# connect). To simulate the reported scenario — a bridge that crashed (e.g. on
# machine reboot) and now gets a 401 on its auto-restart attempt — we connect
# successfully against a temporarily-permissive server, then kill the bridge
# and edit sessions.json to look like a freshly-crashed bridge with bad creds.
# =============================================================================

test_case "create session with valid bearer, then simulate crashed state with bad bearer"

# Connect with a valid bearer — server accepts any "Bearer <token>" shape
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" \
  --header "X-Test: true" \
  --header "Authorization: Bearer good-token"
assert_success

# Stop the bridge process so it's no longer running
run_mcpc "$SESSION" close
assert_success

# Recreate the session record by hand — sessions.json after `close` deletes
# the entry, so we re-add it directly in the state we want to test:
# - status: 'crashed' (no pid alive)
# - lastConnectionAttemptAt aged past the 10s auto-retry cooldown
# - bad Authorization header so the auto-restart hits 401
sessions_file="$MCPC_HOME_DIR/sessions.json"
old_iso="2000-01-01T00:00:00.000Z"
tmp_file="$TEST_TMP/sessions.json.$$"

# Save bad headers to the keychain used by restartBridge on auto-reconnect
# (headers are loaded from the keychain, not sessions.json, on restart).
# Use a native path for require() — on Windows Node treats a leading "/" as the
# current drive root, so "/d/a/.../keychain.js" resolves to "D:\d\a\..." (wrong).
NATIVE_PROJECT_ROOT="$(to_native_path "$PROJECT_ROOT")"
NATIVE_MCPC_HOME="$(to_native_path "$MCPC_HOME_DIR")"
node -e "
  process.env.MCPC_HOME_DIR = '$NATIVE_MCPC_HOME';
  const { storeKeychainSessionHeaders } = require('$NATIVE_PROJECT_ROOT/dist/lib/auth/keychain.js');
  storeKeychainSessionHeaders('$SESSION', {
    'X-Test': 'true',
    'Authorization': 'InvalidScheme not-a-bearer-token'
  }).catch(e => { console.error(e); process.exit(1); });
"

# Reconstruct the session entry: crashed state, no pid, old attempt timestamp,
# headers placeholder so the restart path knows to load headers from keychain.
jq --arg name "$SESSION" \
   --arg url "$TEST_SERVER_URL" \
   --arg when "$old_iso" \
   '.sessions[$name] = {
      "name": $name,
      "server": {
        "url": $url,
        "headers": { "X-Test": "<redacted>", "Authorization": "<redacted>" }
      },
      "transport": "http",
      "createdAt": $when,
      "lastConnectionAttemptAt": $when,
      "status": "crashed"
    }' \
  "$sessions_file" > "$tmp_file"
mv "$tmp_file" "$sessions_file"

test_pass

# =============================================================================
# Test: a single `mcpc` listing triggers an auto-restart that propagates the
# 'unauthorized' status within a reasonable window (no explicit session access
# required to surface the auth error).
# =============================================================================

test_case "auto-reconnect from crashed -> unauthorized without explicit access"

# Trigger auto-reconnect (fire-and-forget) via the listing command.
run_mcpc --json
assert_success

# Poll the session status: it should transition to 'unauthorized' once the
# bridge spawned by the listing's fire-and-forget reconnect completes its
# initial handshake and gets a 401. Allow up to 15s for the bridge spawn,
# IPC creds, MCP initialize, and 401 response to complete.
deadline=$((SECONDS + 15))
final_status=""
while (( SECONDS < deadline )); do
  run_mcpc --json
  final_status=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$SESSION\") | .status")
  if [[ "$final_status" == "unauthorized" ]]; then
    break
  fi
  sleep 0.5
done

if [[ "$final_status" != "unauthorized" ]]; then
  test_fail "expected status 'unauthorized' within 15s, got: '$final_status'"
  exit 1
fi
test_pass

test_done
