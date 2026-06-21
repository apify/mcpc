#!/bin/bash
# Test: --token-endpoint pins the OAuth token endpoint for the client-credentials grant.
#
# The server here serves /token but NOT the .well-known metadata document, so endpoint
# discovery fails. This proves --token-endpoint is honored both at login and — via the
# SDK provider's injected discoveryState — at runtime when the bridge connects.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/client-credentials-token-endpoint" --isolated

start_test_server WITH_OAUTH=true OAUTH_NO_METADATA=true REQUIRE_AUTH=true \
  OAUTH_CLIENT_ID=test-client OAUTH_CLIENT_SECRET=s3cr3t

test_case "login --grant client-credentials with --token-endpoint succeeds without discovery"
run_mcpc login "$TEST_SERVER_URL" --grant client-credentials \
  --client-id test-client --client-secret s3cr3t \
  --token-endpoint "$TEST_SERVER_URL/token" --profile cc
assert_success
assert_contains "$STDOUT" "Authentication successful"
test_pass

test_case "connect with the pinned token endpoint and list tools (runtime uses the override)"
run_mcpc connect "$TEST_SERVER_URL" @cc-te --profile cc
assert_success
run_mcpc @cc-te tools-list
assert_success
assert_contains "$STDOUT" "echo"
test_pass

test_case "login accepts the client_credentials (underscore) grant spelling"
run_mcpc login "$TEST_SERVER_URL" --grant client_credentials \
  --client-id test-client --client-secret s3cr3t \
  --token-endpoint "$TEST_SERVER_URL/token" --profile cc2
assert_success
assert_contains "$STDOUT" "Authentication successful"
test_pass

run_mcpc close @cc-te || true

test_done
