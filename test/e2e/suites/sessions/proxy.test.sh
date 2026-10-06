#!/bin/bash
# Test: Proxy server for AI isolation
# Tests the --proxy option that creates a secondary MCP server
# that forwards requests without exposing original auth tokens

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/proxy" --isolated

# Start test server
start_test_server

# Generate unique session names
SESSION_UPSTREAM=$(session_name "proxy-upstream")
SESSION_DOWNSTREAM=$(session_name "proxy-downstream")

# Find an available port for proxy
PROXY_PORT=$((8100 + RANDOM % 100))

# Test: connect with --proxy option creates session with proxy server
test_case "connect with --proxy creates session"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION_UPSTREAM" --header "X-Test: true" --proxy "$PROXY_PORT"
assert_success "connect with --proxy should succeed"
assert_contains "$STDOUT" "created"
_SESSIONS_CREATED+=("$SESSION_UPSTREAM")
test_pass

# Wait for proxy server to be ready
wait_for "curl -s http://127.0.0.1:$PROXY_PORT/health 2>/dev/null | grep -q ok"

# Test: session shows proxy info
test_case "session shows proxy info in list"
run_mcpc --json
assert_success
session_info=$(json_get ".sessions[] | select(.name == \"$SESSION_UPSTREAM\")")
assert_not_empty "$session_info" "session should exist"
proxy_host=$(echo "$session_info" | jq -r '.proxy.host // empty')
proxy_port=$(echo "$session_info" | jq -r '.proxy.port // empty')
assert_eq "$proxy_host" "127.0.0.1" "proxy host should be 127.0.0.1"
assert_eq "$proxy_port" "$PROXY_PORT" "proxy port should match"
test_pass

# Test: proxy health endpoint works
test_case "proxy health endpoint responds"
health_response=$(curl -s "http://127.0.0.1:$PROXY_PORT/health" 2>/dev/null || echo "CURL_FAILED")
if [[ "$health_response" == "CURL_FAILED" ]]; then
  test_fail "could not connect to proxy health endpoint"
  exit 1
fi
assert_contains "$health_response" "ok" "health endpoint should return ok"
test_pass

# Test: can connect to proxy as MCP server (localhost defaults to http://)
test_case "connect to proxy server"
# Ensure proxy is still healthy before connecting downstream
wait_for "curl -s http://127.0.0.1:$PROXY_PORT/health 2>/dev/null | grep -q ok"
run_mcpc connect "127.0.0.1:$PROXY_PORT" "$SESSION_DOWNSTREAM"
assert_success "connect to proxy should succeed"
_SESSIONS_CREATED+=("$SESSION_DOWNSTREAM")

# Wait for downstream bridge to be fully ready
wait_for "$MCPC $SESSION_DOWNSTREAM ping >/dev/null 2>&1"
test_pass

# Test: proxy passes through upstream server instructions
test_case "proxy passes instructions"
run_mcpc --json "$SESSION_DOWNSTREAM"
assert_success
instructions=$(json_get '.instructions // empty')
assert_not_empty "$instructions" "proxy should return instructions"
assert_contains "$instructions" "E2E test server" "instructions should be from upstream server"
test_pass

# Test: tools-list works through proxy
test_case "tools-list works via proxy"
run_mcpc "$SESSION_DOWNSTREAM" tools-list
assert_success
assert_contains "$STDOUT" "echo"
test_pass

# Test: the proxy advertises completions because the upstream test server declares them
test_case "proxy advertises and forwards completions"
run_mcpc "$SESSION_DOWNSTREAM"
assert_success
assert_contains "$STDOUT" "completions"
run_mcpc --json "$SESSION_DOWNSTREAM" completion-complete prompt greeting style:=f
assert_success
assert_json "$STDOUT" '.completion.values == ["formal"]'
test_pass

# Test: tools-call works through proxy
test_case "tools-call works via proxy"
run_mcpc "$SESSION_DOWNSTREAM" tools-call echo 'message:=proxied message'
assert_success
assert_contains "$STDOUT" "proxied message"
test_pass

# Test: close downstream session
test_case "close downstream session"
run_mcpc "$SESSION_DOWNSTREAM" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION_DOWNSTREAM}")
test_pass

# Test: close upstream session (also stops proxy)
test_case "close upstream session"
run_mcpc "$SESSION_UPSTREAM" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION_UPSTREAM}")
test_pass

# Test: proxy no longer available after upstream close
test_case "proxy unavailable after close"
health_response=$(curl -s --max-time 2 "http://127.0.0.1:$PROXY_PORT/health" 2>/dev/null || echo "CURL_FAILED")
assert_eq "$health_response" "CURL_FAILED" "proxy should be unavailable after close"
test_pass

# ========================================
# Port conflict detection tests
# ========================================

SESSION_CONFLICT1=$(session_name "proxy-conflict1")
SESSION_CONFLICT2=$(session_name "proxy-conflict2")
PROXY_PORT_CONFLICT=$((8300 + RANDOM % 100))

# Test: create first session with proxy
test_case "create first session with proxy for conflict test"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION_CONFLICT1" --header "X-Test: true" --proxy "$PROXY_PORT_CONFLICT"
assert_success
_SESSIONS_CREATED+=("$SESSION_CONFLICT1")
test_pass

# Wait for proxy to be ready before testing conflict
wait_for "curl -s http://127.0.0.1:$PROXY_PORT_CONFLICT/health 2>/dev/null | grep -q ok"

# Test: second session on same port should fail
test_case "second session on same port fails"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION_CONFLICT2" --header "X-Test: true" --proxy "$PROXY_PORT_CONFLICT"
assert_failure "should fail when port is already in use"
assert_contains "$STDERR" "already in use" "error should mention port in use"
test_pass

# Test: cleanup conflict test session
test_case "cleanup conflict test session"
run_mcpc "$SESSION_CONFLICT1" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION_CONFLICT1}")
test_pass

# ========================================
# Bearer token authentication tests
# ========================================

SESSION_AUTH=$(session_name "proxy-auth")
PROXY_PORT_AUTH=$((8200 + RANDOM % 100))
BEARER_TOKEN="test-secret-token-12345"

# Test: create session with proxy and bearer token
test_case "connect with --proxy-bearer-token"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION_AUTH" --header "X-Test: true" --proxy "$PROXY_PORT_AUTH" --proxy-bearer-token "$BEARER_TOKEN"
assert_success "connect with --proxy-bearer-token should succeed"
_SESSIONS_CREATED+=("$SESSION_AUTH")
test_pass

# Wait for proxy to be ready
wait_for "curl -s http://127.0.0.1:$PROXY_PORT_AUTH/health 2>/dev/null | grep -q ok"

# Test: health endpoint works without auth (health is public)
test_case "proxy health endpoint works without auth"
health_response=$(curl -s "http://127.0.0.1:$PROXY_PORT_AUTH/health" 2>/dev/null || echo "CURL_FAILED")
assert_contains "$health_response" "ok" "health endpoint should work without auth"
test_pass

# Test: MCP request without auth returns 401
test_case "proxy rejects unauthenticated MCP requests"
response=$(curl -s -w "\n%{http_code}" -X POST "http://127.0.0.1:$PROXY_PORT_AUTH/" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"ping","id":1}' 2>/dev/null)
http_code=$(echo "$response" | tail -1)
assert_eq "$http_code" "401" "should return 401 for unauthenticated request"
test_pass

# Test: MCP request with wrong token returns 403
test_case "proxy rejects wrong bearer token"
response=$(curl -s -w "\n%{http_code}" -X POST "http://127.0.0.1:$PROXY_PORT_AUTH/" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer wrong-token" \
  -d '{"jsonrpc":"2.0","method":"ping","id":1}' 2>/dev/null)
http_code=$(echo "$response" | tail -1)
assert_eq "$http_code" "403" "should return 403 for wrong token"
test_pass

# Test: MCP request with correct token succeeds (send initialize as proper MCP clients do)
test_case "proxy accepts correct bearer token"
response=$(curl -s -w "\n%{http_code}" -X POST "http://127.0.0.1:$PROXY_PORT_AUTH/" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $BEARER_TOKEN" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":1}' 2>/dev/null)
http_code=$(echo "$response" | tail -1)
# Should be 200 (success) or 202 (accepted for streaming)
if [[ "$http_code" != "200" && "$http_code" != "202" ]]; then
  test_fail "expected 200 or 202, got $http_code"
  exit 1
fi
test_pass

# Test: bearer token not leaked in --verbose output
test_case "bearer token not leaked in verbose output"
run_mcpc --verbose "$SESSION_AUTH" tools-list
assert_success
# Check that the actual token value doesn't appear in stdout or stderr
if echo "$STDOUT" | grep -q "$BEARER_TOKEN"; then
  test_fail "bearer token leaked in stdout"
  exit 1
fi
if echo "$STDERR" | grep -q "$BEARER_TOKEN"; then
  test_fail "bearer token leaked in stderr"
  exit 1
fi
test_pass

# Test: bearer token not leaked in bridge logs
test_case "bearer token not leaked in bridge logs"
# Find the bridge log file for this session
BRIDGE_LOG="$MCPC_HOME_DIR/logs/bridge-$SESSION_AUTH.log"
if [[ -f "$BRIDGE_LOG" ]]; then
  if grep -q "$BEARER_TOKEN" "$BRIDGE_LOG"; then
    test_fail "bearer token leaked in bridge log"
    exit 1
  fi
fi
test_pass

# Test: close auth session
test_case "close auth session"
run_mcpc "$SESSION_AUTH" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION_AUTH}")
test_pass

test_done
