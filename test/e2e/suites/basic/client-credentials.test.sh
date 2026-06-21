#!/bin/bash
# Test: OAuth client-credentials grant (machine-to-machine login + connect)
#
# Uses the test server's opt-in OAuth endpoints (WITH_OAUTH): a metadata
# document advertising a /token endpoint that accepts the client-credentials
# grant. Exercises CLI flag validation, a full login → connect → tools-list
# happy path with a client secret, and the wrong-secret failure path.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/client-credentials" --isolated

start_test_server WITH_OAUTH=true REQUIRE_AUTH=true OAUTH_CLIENT_ID=test-client OAUTH_CLIENT_SECRET=s3cr3t

# --- CLI flag validation (fails before any network) ---

test_case "login help documents the client-credentials grant"
run_mcpc help login
assert_success
assert_contains "$STDOUT" "client-credentials"
assert_contains "$STDOUT" "--client-key"
assert_contains "$STDOUT" "--token-endpoint"
test_pass

test_case "client-credentials grant without --client-id is rejected"
run_xmcpc login "$TEST_SERVER_URL" --grant client-credentials --client-secret s3cr3t
assert_failure
assert_contains "$STDERR" "requires --client-id"
test_pass

test_case "client-credentials grant with both --client-secret and --client-key is rejected"
run_xmcpc login "$TEST_SERVER_URL" --grant client-credentials --client-id test-client --client-secret s3cr3t --client-key somekey
assert_failure
assert_contains "$STDERR" "exactly one of"
test_pass

test_case "client-credentials grant with an unsupported --client-key-alg is rejected"
run_xmcpc login "$TEST_SERVER_URL" --grant client-credentials --client-id test-client --client-key somekey --client-key-alg HS256
assert_failure
assert_contains "$STDERR" "Supported algorithms"
test_pass

test_case "unknown --grant value is rejected"
run_xmcpc login "$TEST_SERVER_URL" --grant bogus
assert_failure
assert_contains "$STDERR" "Invalid --grant"
test_pass

test_case "--token-endpoint without --grant client-credentials is rejected"
run_xmcpc login "$TEST_SERVER_URL" --token-endpoint https://auth.example.com/token
assert_failure
assert_contains "$STDERR" "only supported with --grant client-credentials"
test_pass

# --- Happy path: client_secret variant ---

test_case "login with the client-credentials grant (client secret) succeeds"
run_mcpc login "$TEST_SERVER_URL" --grant client-credentials --client-id test-client --client-secret s3cr3t --scope "read write" --profile cc
assert_success
assert_contains "$STDOUT" "Authentication successful"
assert_contains "$STDOUT" "read, write"
test_pass

test_case "profile listing marks the client-credentials profile"
run_mcpc
assert_success
assert_contains "$STDOUT" "client credentials"
test_pass

test_case "connect with the client-credentials profile and list tools"
run_mcpc connect "$TEST_SERVER_URL" @cc --profile cc
assert_success
run_mcpc @cc tools-list
assert_success
assert_contains "$STDOUT" "echo"
test_pass

# --- Negative: a wrong client secret fails at login (exit code 4) ---

test_case "login with a wrong client secret fails with an auth error"
run_xmcpc login "$TEST_SERVER_URL" --grant client-credentials --client-id test-client --client-secret WRONG --profile bad
assert_failure
assert_exit_code 4
test_pass

run_mcpc close @cc || true

test_done
