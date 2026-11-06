#!/bin/bash
# Local authorization-code/PKCE and refresh flow through the real CLI and SDK.
source "$(dirname "$0")/../../lib/framework.sh"
test_init "auth/oauth-code" --isolated
if [[ "${OS:-}" == "Windows_NT" ]]; then
  skip_suite "The scoped open/xdg-open browser driver needs a POSIX launcher"
fi
umask 077
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="$NO_PROXY"

OAUTH_HELPER="$PROJECT_ROOT/test/e2e/lib/oauth-local.mjs"
OAUTH_MANIFEST="$TEST_TMP/oauth-identities.json"

cleanup_oauth_code() {
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
    rm -rf "$TEST_TMP/partial-home" "$TEST_TMP/browser-bin"
  else
    echo "Exact OAuth credential cleanup failed; keeping the private registry for retry" >&2
    result=1
  fi
  exit "$result"
}
trap cleanup_oauth_code EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${E2E_RUNTIME:-node}" "$OAUTH_HELPER" init-code "$OAUTH_MANIFEST" "$(to_native_path "$MCPC_HOME_DIR")"
start_test_server "OAUTH_IDENTITIES_FILE=$(to_native_path "$OAUTH_MANIFEST")"

test_case "authorization-code PKCE, rotating refresh, restart, logout and owned credential cleanup"
if "${E2E_RUNTIME:-node}" "$OAUTH_HELPER" run-code "$OAUTH_MANIFEST" "$TEST_SERVER_URL"; then
  test_pass
else
  test_fail "Local authorization-code assertions failed (see oauth-commands.log)"
  exit 1
fi
test_done
