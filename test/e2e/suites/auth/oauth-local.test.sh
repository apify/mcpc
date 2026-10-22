#!/bin/bash
# Deterministic client-credentials coverage. No accounts or remote services.
source "$(dirname "$0")/../../lib/framework.sh"
test_init "auth/oauth-local" --isolated
umask 077
# Auth traffic must stay on loopback even when the developer configures a proxy.
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="$NO_PROXY"

OAUTH_HELPER="$PROJECT_ROOT/test/e2e/lib/oauth-local.mjs"
OAUTH_MANIFEST="$TEST_TMP/oauth-identities.json"

# The helper registers exact credential identities before login can write them.
# Run cleanup again from the shell trap in case the helper failed/interrupted.
# Never delete the isolated home before checking keychain/fallback-store absence.
cleanup_oauth_local() {
  local result=$?
  trap - EXIT INT TERM
  set +e
  local cleanup_result=0
  if [[ -f "$OAUTH_MANIFEST" ]]; then
    "${E2E_RUNTIME:-node}" "$OAUTH_HELPER" cleanup "$OAUTH_MANIFEST"
    cleanup_result=$?
  fi
  stop_test_server
  if [[ $cleanup_result -eq 0 ]]; then
    _test_cleanup
    rm -f "$OAUTH_MANIFEST"
    rm -rf "$TEST_TMP/partial-home"
  else
    echo "Exact OAuth credential cleanup failed; keeping the private registry for retry" >&2
    result=1
  fi
  exit "$result"
}
trap cleanup_oauth_local EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${E2E_RUNTIME:-node}" "$OAUTH_HELPER" init "$OAUTH_MANIFEST" "$(to_native_path "$MCPC_HOME_DIR")"
start_test_server "OAUTH_IDENTITIES_FILE=$(to_native_path "$OAUTH_MANIFEST")"

test_case "local client-credentials isolation, bounded recovery, logout and exact cleanup"
if "${E2E_RUNTIME:-node}" "$OAUTH_HELPER" run "$OAUTH_MANIFEST" "$TEST_SERVER_URL"; then
  test_pass
else
  test_fail "Local OAuth assertions failed (see oauth-commands.log)"
  exit 1
fi
test_done
