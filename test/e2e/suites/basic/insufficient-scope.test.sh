#!/bin/bash
# Test: step-up authorization — a server answering 403 insufficient_scope
# (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#step-up-authorization-flow)
#
# The test server gates the `echo` tool behind the `files:write` scope. A session
# authenticated with a static bearer header cannot step up on its own: mcpc must
# name the missing scope and the login that adds it, and keep the session usable.
# A client-credentials session steps up automatically (the SDK repeats the grant
# with the widened scope and retries).

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/insufficient-scope" --isolated

start_test_server WITH_OAUTH=true REQUIRE_AUTH=true SCOPE_GATE_TOOL=echo SCOPE_GATE_SCOPE=files:write \
  OAUTH_CLIENT_ID=test-client OAUTH_CLIENT_SECRET=s3cr3t

# =============================================================================
# Static bearer header: the error is the step-up
# =============================================================================

HDR_SESSION=$(session_name "hdr")
run_mcpc connect "$TEST_SERVER_URL" "$HDR_SESSION" -H "Authorization: Bearer static-token"
assert_success

test_case "an ungated tool works with the static token"
run_mcpc "$HDR_SESSION" tools-call add '{"a":1,"b":2}'
assert_success
test_pass

test_case "403 insufficient_scope fails with exit code 4 and names the missing scope"
run_mcpc "$HDR_SESSION" tools-call echo message:=hi
assert_failure
assert_exit_code 4
assert_contains "$STDERR" "Insufficient scope"
assert_contains "$STDERR" "files:write"
assert_contains "$STDERR" "needs scope files:write"
assert_contains "$STDERR" "mcpc login"
assert_contains "$STDERR" "--scope"
test_pass

test_case "403 insufficient_scope in --json mode is a JSON error with code 4"
run_mcpc "$HDR_SESSION" tools-call echo message:=hi --json
assert_failure
assert_exit_code 4
assert_json_valid "$STDERR"
assert_json "$STDERR" ".code == 4"
assert_stdout_empty
test_pass

test_case "the session stays live after a scope challenge"
run_mcpc "$HDR_SESSION" tools-call add '{"a":2,"b":3}'
assert_success
run_mcpc --json
assert_success
STATUS=$(echo "$STDOUT" | jq -r ".sessions[] | select(.name == \"$HDR_SESSION\") | .status")
assert_eq "$STATUS" "live" "session must not be marked unauthorized"
test_pass

run_mcpc "$HDR_SESSION" close || true

# =============================================================================
# Client-credentials profile: the SDK steps up on its own
# =============================================================================

test_case "login with the client-credentials grant and a narrow scope"
run_mcpc login "$TEST_SERVER_URL" --grant client-credentials --client-id test-client --client-secret s3cr3t --scope read --profile cc
assert_success
assert_contains "$STDOUT" "Scopes: read"
test_pass

CC_SESSION=$(session_name "cc")
run_mcpc connect "$TEST_SERVER_URL" "$CC_SESSION" --profile cc
assert_success

test_case "a client-credentials session steps up to the challenged scope and retries"
run_mcpc "$CC_SESSION" tools-call echo message:=stepped-up
assert_success
assert_contains "$STDOUT" "stepped-up"
test_pass

run_mcpc "$CC_SESSION" close || true

test_done
