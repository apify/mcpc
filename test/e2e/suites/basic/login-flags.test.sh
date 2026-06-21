#!/bin/bash
# Test: login command flag validation (client registration + callback host/port)
#
# CLI-side validation for the `login` command: the three client registration
# approaches (--client-id / --client-secret / --client-metadata-url), CIMD
# opt-out, and --callback-host / --callback-port. None of these reach the
# network or the MCP test server, so they live here rather than in
# basic/auth-errors to keep that suite within its per-test time budget.
#
# Pure arg-validation errors all flow through one formatting code path, so we
# spot-check the --json/--verbose invariants once with run_xmcpc and use a
# single run_mcpc invocation for every other message assertion. This keeps the
# suite fast (run_xmcpc runs each command five times). The only exception is the
# end-to-end --callback-port binding check at the bottom, which spawns a
# throwaway loopback server (still no MCP test server).

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/login-flags"

# =============================================================================
# login --help documents every flag and client registration approach.
# The help output is static, so assert all the strings from a single invocation.
# =============================================================================
test_case "login --help documents client registration approaches and callback flags"
run_mcpc help login
assert_success
# Three client registration approaches
assert_contains "$STDOUT" "--client-id"
assert_contains "$STDOUT" "--client-secret"
assert_contains "$STDOUT" "--client-metadata-url"
assert_contains "$STDOUT" "Pre-registration"
assert_contains "$STDOUT" "Client ID Metadata Documents"
assert_contains "$STDOUT" "Dynamic Client Registration"
# CIMD opt-out and the full default CIMD URL
assert_contains "$STDOUT" "--no-client-metadata-url"
assert_contains "$STDOUT" "apify.github.io"
assert_contains "$STDOUT" "https://apify.github.io/mcpc/client-metadata.json"
# Callback host/port and the actual default callback ports
assert_contains "$STDOUT" "--callback-host"
assert_contains "$STDOUT" "--callback-port"
assert_contains "$STDOUT" "13316"
assert_contains "$STDOUT" "31613"
assert_contains "$STDOUT" "16133"
test_pass

# =============================================================================
# Client registration flag validation.
# The first case uses run_xmcpc to verify the validation-error path honours the
# --json/--verbose invariants; the rest use run_mcpc (single invocation).
# =============================================================================
test_case "login --client-secret without --client-id fails"
run_xmcpc login mcp.example.com --client-secret some-secret
assert_failure
assert_contains "$STDERR" "--client-secret requires --client-id"
test_pass

test_case "login --client-id with --client-metadata-url is rejected as mutually exclusive"
run_mcpc login mcp.example.com --client-id foo --client-metadata-url https://example.com/meta.json
assert_failure
assert_contains "$STDERR" "mutually exclusive"
test_pass

test_case "login --client-metadata-url with non-https URL is rejected"
run_mcpc login mcp.example.com --client-metadata-url http://example.com/meta.json
assert_failure
assert_contains "$STDERR" "https"
test_pass

test_case "login --client-metadata-url without a path component is rejected"
run_mcpc login mcp.example.com --client-metadata-url https://example.com
assert_failure
assert_contains "$STDERR" "path component"
test_pass

test_case "login --client-metadata-url with a fragment is rejected"
run_mcpc login mcp.example.com --client-metadata-url "https://example.com/meta.json#frag"
assert_failure
assert_contains "$STDERR" "fragment"
test_pass

test_case "login --client-metadata-url with credentials is rejected"
run_mcpc login mcp.example.com --client-metadata-url "https://user:pass@example.com/meta.json"
assert_failure
assert_contains "$STDERR" "username or password"
test_pass

test_case "login --client-metadata-url with dot segments is rejected"
run_mcpc login mcp.example.com --client-metadata-url "https://example.com/../meta.json"
assert_failure
assert_contains "$STDERR" "path segments"
test_pass

# =============================================================================
# --callback-port validation
# =============================================================================
test_case "login --callback-port with non-numeric value is rejected"
run_mcpc login mcp.example.com --callback-port abc --no-client-metadata-url
assert_failure
assert_contains "$STDERR" "--callback-port"
test_pass

test_case "login --callback-port with 0 is rejected"
run_mcpc login mcp.example.com --callback-port 0 --no-client-metadata-url
assert_failure
assert_contains "$STDERR" "--callback-port"
test_pass

test_case "login --callback-port above 65535 is rejected"
run_mcpc login mcp.example.com --callback-port 65536 --no-client-metadata-url
assert_failure
assert_contains "$STDERR" "--callback-port"
test_pass

test_case "login --callback-port negative is rejected"
run_mcpc login mcp.example.com --callback-port -1 --no-client-metadata-url
assert_failure
assert_contains "$STDERR" "--callback-port"
test_pass

# =============================================================================
# --callback-host validation
# =============================================================================
test_case "login --callback-host with non-loopback host is rejected"
run_mcpc login mcp.example.com --callback-host evil.example.com --no-client-metadata-url
assert_failure
assert_contains "$STDERR" "--callback-host"
assert_contains "$STDERR" "loopback"
test_pass

test_case "login --callback-host localhost with default hosted CIMD is rejected"
run_mcpc login mcp.example.com --callback-host localhost
assert_failure
assert_contains "$STDERR" "127.0.0.1 redirect URIs"
assert_contains "$STDERR" "--no-client-metadata-url"
test_pass

# Host comparison is case-insensitive (RFC 3986): LOCALHOST normalizes to
# localhost, proven by it hitting the same default-CIMD guard.
test_case "login --callback-host LOCALHOST is normalized to localhost"
run_mcpc login mcp.example.com --callback-host LOCALHOST
assert_failure
assert_contains "$STDERR" "127.0.0.1 redirect URIs"
test_pass

# =============================================================================
# Tier 2 - end-to-end callback port binding
#
# Starts `mcpc login` in the background with --callback-port set, pointing at
# a local HTTP server that accepts connections but never responds. This keeps
# mcpc in the OAuth-discovery phase, so its callback server stays bound long
# enough to observe. We then verify the expected loopback port is listening.
# This proves --callback-port is honored end-to-end, not just parsed.
# =============================================================================

# Pick a likely-free high port outside mcpc's default list for the callback
TEST_CALLBACK_PORT=47317

test_case "login --callback-port binds the requested port on 127.0.0.1"

# Start a hanging HTTP server on a random local port. mcpc will hit this while
# trying to discover OAuth metadata and block indefinitely, which is what we
# want so we can observe the callback server.
STALL_PORT=47318
node -e "require('http').createServer(()=>{}).listen(${STALL_PORT}, '127.0.0.1')" &
STALL_PID=$!

# Wait for the stall server to be ready
for _ in $(seq 1 20); do
  if (echo >/dev/tcp/127.0.0.1/$STALL_PORT) >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

# Start mcpc login in the background. --no-client-metadata-url skips CIMD
# so mcpc goes straight to DCR against the stall server (which hangs).
$MCPC login http://127.0.0.1:$STALL_PORT \
  --callback-port "$TEST_CALLBACK_PORT" \
  --no-client-metadata-url \
  </dev/null >/dev/null 2>&1 &
LOGIN_PID=$!

# Poll for the callback port to be bound (up to 10 seconds)
bound=false
for _ in $(seq 1 100); do
  if (echo >/dev/tcp/127.0.0.1/$TEST_CALLBACK_PORT) >/dev/null 2>&1; then
    bound=true
    break
  fi
  sleep 0.1
done

# Clean up background processes regardless of outcome
_kill_tree "$LOGIN_PID"
wait "$LOGIN_PID" 2>/dev/null || true
_kill_tree "$STALL_PID"
wait "$STALL_PID" 2>/dev/null || true

if [[ "$bound" == "true" ]]; then
  test_pass
else
  test_fail "Port $TEST_CALLBACK_PORT was not bound within 10s"
  exit 1
fi

test_done
