#!/bin/bash
source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/proxy-control-trust" --isolated

if is_windows; then
  test_case "named management refuses unverified named-pipe ownership"
  run_mcpc proxy @unsupported --json
  assert_failure
  assert_contains "$STDERR" "not supported on this platform"
  test_pass
  test_done
  exit 0
fi

test_case "CLI refuses old bridges and unsafe IPC namespaces before credentials"
"${E2E_RUNTIME:-node}" "$PROJECT_ROOT/test/e2e/lib/proxy-control-trust.mjs" "$PROJECT_ROOT"
test_pass
test_done
