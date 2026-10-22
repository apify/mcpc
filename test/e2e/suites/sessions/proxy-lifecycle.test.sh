#!/bin/bash
# Real named-listener lifecycle, auth isolation, restart and offline control.
source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/proxy-lifecycle" --isolated

if is_windows; then
  test_case "new proxy management refuses unverified Windows IPC"
  run_mcpc proxy @unsupported --json
  assert_failure
  assert_contains "$STDERR" "not supported on this platform"
  test_pass
  test_done
  exit 0
fi

start_test_server
test_case "named listeners retain independent lifecycle and credentials"
"${E2E_RUNTIME:-node}" "$PROJECT_ROOT/test/e2e/lib/proxy-lifecycle.mjs" \
  "$PROJECT_ROOT" "$(session_name proxy-lifecycle)"
test_pass
test_done
