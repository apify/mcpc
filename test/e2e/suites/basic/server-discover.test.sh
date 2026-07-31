#!/bin/bash
# Test: `server-discover` sends a live server/discover request on 2026-07-28 connections,
# and refuses (pointing at the equivalent commands) on 2025-era ones.
#
# One suite, one branch per protocol era — the command's whole point is that the era
# decides whether the request exists at all:
#   modern (2026-07-28) - the request is sent and its result reported verbatim
#   legacy (2025-11-25) - server/discover does not exist; the handshake carries the data

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/server-discover"

start_test_server

SESSION=$(session_name "discover")

test_case "create session"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

if [[ "$E2E_SERVER_PROTOCOL" == "modern" ]]; then
  test_case "server-discover reports what the server advertises"
  run_mcpc "$SESSION" server-discover
  assert_success
  assert_contains "$STDOUT" "Supported protocol versions:"
  assert_contains "$STDOUT" "2026-07-28"
  assert_contains "$STDOUT" "Capabilities:"
  assert_contains "$STDOUT" "tools"
  # The server identity comes from the discover result's `_meta`
  assert_contains "$STDOUT" "e2e-test-server"
  test_pass

  test_case "server-discover marks the negotiated version"
  run_mcpc "$SESSION" server-discover
  assert_success
  assert_contains "$STDOUT" "(negotiated)"
  test_pass

  test_case "--json returns the DiscoverResult verbatim"
  run_mcpc --json "$SESSION" server-discover
  assert_success
  assert_json_valid "$STDOUT"
  # supportedVersions and capabilities are the fields DiscoverResult always carries
  assert_json_eq "$STDOUT" '.supportedVersions[0]' '2026-07-28'
  assert_json "$STDOUT" '.capabilities.tools'
  # No mcpc wrapper fields — the shape is the server's answer, not a mcpc summary
  run_mcpc --json "$SESSION" server-discover
  assert_json_eq "$STDOUT" '._mcpc' 'null'
  assert_json_eq "$STDOUT" '.protocolVersion' 'null'
  test_pass

  test_case "ping says which request measured the roundtrip"
  run_mcpc "$SESSION" ping
  assert_success
  # The confusing part of 2026-07-28: `ping` is gone, so the probe is server/discover
  assert_contains "$STDOUT" "server/discover"
  assert_contains "$STDOUT" "server-discover"
  test_pass

  test_case "ping --json output is unchanged by that note"
  run_mcpc --json "$SESSION" ping
  assert_success
  assert_json_valid "$STDOUT"
  assert_json_eq "$STDOUT" '.success' 'true'
  test_pass
else
  test_case "server-discover refuses on a legacy connection"
  run_mcpc "$SESSION" server-discover
  assert_failure
  assert_contains "$STDOUT$STDERR" "server/discover is not available on this connection"
  assert_contains "$STDOUT$STDERR" "2026-07-28"
  assert_contains "$STDOUT$STDERR" "2025-11-25"
  # The refusal must say where the same information lives instead
  assert_contains "$STDOUT$STDERR" "mcpc $SESSION"
  test_pass

  test_case "the refusal is a clean JSON error with a server exit code"
  run_mcpc --json "$SESSION" server-discover
  assert_failure
  assert_json_valid "$STDERR"
  assert_json_eq "$STDERR" '.code' '2'
  test_pass

  test_case "ping does not claim a server/discover probe"
  run_mcpc "$SESSION" ping
  assert_success
  assert_contains "$STDOUT" "Ping successful"
  assert_not_contains "$STDOUT" "server/discover"
  test_pass
fi

test_case "close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
