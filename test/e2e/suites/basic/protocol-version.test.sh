#!/bin/bash
# Test: --protocol-version pins the MCP protocol version on connect
#
# Runs in both eras of the protocol matrix: the pin matching the active test
# server succeeds and is displayed; the mismatched pin fails the handshake.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/protocol-version" --isolated

# Start test server
start_test_server

# Which pin matches the active test server, and which one cannot
if [[ "$E2E_SERVER_PROTOCOL" == "modern" ]]; then
  MATCH_VERSION="2026-07-28"
  MISMATCH_VERSION="2025-11-25"
else
  MATCH_VERSION="2025-11-25"
  MISMATCH_VERSION="2026-07-28"
fi

# =============================================================================
# Test: unsupported version is rejected before connecting
# =============================================================================

test_case "connect rejects an unsupported --protocol-version"
run_mcpc connect "$TEST_SERVER_URL" "$(session_name "inv")" --header "X-Test: true" --protocol-version 1999-01-01
assert_failure
assert_contains "$STDERR" "Unsupported MCP protocol version: 1999-01-01"
assert_contains "$STDERR" "Supported versions:"
test_pass

# =============================================================================
# Test: pin matching the server's protocol version
# =============================================================================

SESSION=$(session_name "pin")

test_case "connect with a matching --protocol-version succeeds"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true" --protocol-version "$MATCH_VERSION"
assert_success
_SESSIONS_CREATED+=("$SESSION")
assert_contains "$STDOUT" "Protocol: $MATCH_VERSION"
test_pass

test_case "session info shows the negotiated version as pinned"
run_mcpc "$SESSION"
assert_success
assert_contains "$STDOUT" "Protocol: $MATCH_VERSION"
assert_contains "$STDOUT" "pinned"
test_pass

test_case "JSON session info includes the protocolVersion pin"
run_mcpc --json "$SESSION"
assert_success
assert_json_valid "$STDOUT"
assert_json_eq "$STDOUT" '._mcpc.server.protocolVersion' "$MATCH_VERSION"
assert_json_eq "$STDOUT" '.protocolVersion' "$MATCH_VERSION"
test_pass

test_case "the pin survives a session restart"
run_mcpc "$SESSION" restart
assert_success
run_mcpc "$SESSION"
assert_success
assert_contains "$STDOUT" "Protocol: $MATCH_VERSION"
assert_contains "$STDOUT" "pinned"
test_pass

test_case "tools work on a pinned session"
run_mcpc "$SESSION" tools-call echo message:="pinned hello"
assert_success
assert_contains "$STDOUT" "pinned hello"
test_pass

run_mcpc "$SESSION" close 2>/dev/null || true

# =============================================================================
# Test: pin the server cannot satisfy fails the handshake
# =============================================================================

test_case "connect with a mismatched --protocol-version does not connect"
MISMATCH_SESSION=$(session_name "mis")
run_mcpc connect "$TEST_SERVER_URL" "$MISMATCH_SESSION" --header "X-Test: true" --protocol-version "$MISMATCH_VERSION"
_SESSIONS_CREATED+=("$MISMATCH_SESSION")
# The session record is created but the handshake must fail — the CLI reports the
# failure (with the pin hint) instead of a connected server.
assert_contains "$STDOUT$STDERR" "pinned to MCP $MISMATCH_VERSION"
assert_not_contains "$STDOUT" "Protocol: $MISMATCH_VERSION"
test_pass

run_mcpc "$MISMATCH_SESSION" close 2>/dev/null || true

test_done
