#!/bin/bash
# Test: login --callback-host and --callback-port flag validation
#
# These tests exercise CLI-side validation only (no network, no test server),
# so they live in their own file rather than basic/auth-errors to keep that
# suite within its per-test time budget.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/login-flags"

# Commander wraps long option descriptions, so assert each port separately.
test_case "login --help documents --callback-host and the actual default ports"
run_mcpc help login
assert_success
assert_contains "$STDOUT" "--callback-host"
assert_contains "$STDOUT" "13316"
assert_contains "$STDOUT" "31613"
assert_contains "$STDOUT" "16133"
test_pass

test_case "login --callback-host with non-loopback host is rejected"
run_xmcpc login mcp.example.com --callback-host evil.example.com --no-client-metadata-url
assert_failure
assert_contains "$STDERR" "--callback-host"
assert_contains "$STDERR" "loopback"
test_pass

test_case "login --callback-host localhost with default hosted CIMD is rejected"
run_xmcpc login mcp.example.com --callback-host localhost
assert_failure
assert_contains "$STDERR" "127.0.0.1 redirect URIs"
assert_contains "$STDERR" "--no-client-metadata-url"
test_pass

# Host comparison is case-insensitive (RFC 3986): LOCALHOST normalizes to
# localhost, proven by it hitting the same default-CIMD guard.
test_case "login --callback-host LOCALHOST is normalized to localhost"
run_xmcpc login mcp.example.com --callback-host LOCALHOST
assert_failure
assert_contains "$STDERR" "127.0.0.1 redirect URIs"
test_pass

test_done
