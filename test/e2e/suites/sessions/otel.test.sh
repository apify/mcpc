#!/bin/bash
# Test: connect --otel — OpenTelemetry export and W3C trace context propagation

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/otel"

start_test_server
start_otlp_receiver

SESSION=$(session_name "otel")
PLAIN_SESSION=$(session_name "otel-plain")

# The caller's trace, as a CI runner or agent harness would hand it to mcpc
TRACE_ID="0af7651916cd43dd8448eb211c80319c"
PARENT_SPAN_ID="b7ad6b7169203331"
CALLER_TRACEPARENT="00-$TRACE_ID-$PARENT_SPAN_ID-01"

# Protocol version the matrix column negotiates
EXPECTED_PROTOCOL="2025-11-25"
[[ "$E2E_SERVER_PROTOCOL" == "modern" ]] && EXPECTED_PROTOCOL="2026-07-28"

# The bridge inherits the exporter configuration from the environment of the command
# that starts it; flush fast so the suite does not wait for the default batching.
export OTEL_EXPORTER_OTLP_ENDPOINT="$OTLP_RECEIVER_URL"
export OTEL_BSP_SCHEDULE_DELAY=100
export OTEL_METRIC_EXPORT_INTERVAL=500
export OTEL_SERVICE_NAME="mcpc-e2e"

# Never inherit a trace from the environment running the suite (CI runners set one)
unset TRACEPARENT TRACESTATE BAGGAGE

# =============================================================================
# connect --otel
# =============================================================================

test_case "connect --otel creates a session that reports telemetry"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --otel
assert_success
_SESSIONS_CREATED+=("$SESSION")
assert_contains "$STDOUT" "Telemetry: OpenTelemetry"
test_pass

test_case "session list and details carry the otel flag"
run_mcpc
assert_success
assert_contains "$STDOUT" "[otel]"
run_mcpc --json
assert_success
assert_eq "$(json_get ".sessions[] | select(.name == \"$SESSION\") | .otel")" "true" "sessions.json should record otel: true"
run_mcpc --json "$SESSION"
assert_success
assert_eq "$(json_get "._mcpc.otel")" "true" "session details JSON should carry _mcpc.otel"
test_pass

# =============================================================================
# Trace context propagation (SEP-414)
# =============================================================================

test_case "tool call carries the caller's trace context in _meta"
curl -s -X POST "$TEST_SERVER_URL/control/reset" >/dev/null
TRACEPARENT="$CALLER_TRACEPARENT" TRACESTATE="vendor=abc" run_mcpc "$SESSION" tools-call echo message:=traced
assert_success
assert_contains "$STDOUT" "traced"
META=$(curl -s "$TEST_SERVER_URL/control/get-last-tool-call-meta")
SERVER_TRACEPARENT=$(echo "$META" | jq -r '.meta.traceparent // ""')
if [[ ! "$SERVER_TRACEPARENT" =~ ^00-${TRACE_ID}-[0-9a-f]{16}-01$ ]]; then
  test_fail "server should receive _meta.traceparent in the caller's trace (got: '$SERVER_TRACEPARENT', meta: $META)"
  exit 1
fi
assert_eq "$(echo "$META" | jq -r '.meta.tracestate // ""')" "vendor=abc" "server should receive _meta.tracestate"
test_pass

test_case "client span joins the caller's trace and is the parent the server saw"
# 00-<32 hex trace id>-<16 hex span id>-01 → the span id starts at offset 36
CLIENT_SPAN_ID="${SERVER_TRACEPARENT:36:16}"
if ! wait_for "otlp_spans | jq -e --arg id '$CLIENT_SPAN_ID' '.spans[] | select(.spanId == \$id)' >/dev/null" 20; then
  test_fail "span $CLIENT_SPAN_ID was not exported (spans: $(otlp_spans | jq -c '[.spans[].name]'))"
  exit 1
fi
SPAN=$(otlp_spans | jq -c --arg id "$CLIENT_SPAN_ID" '.spans[] | select(.spanId == $id)')
assert_eq "$(echo "$SPAN" | jq -r '.name')" "tools/call echo" "span name"
assert_eq "$(echo "$SPAN" | jq -r '.traceId')" "$TRACE_ID" "span trace id"
assert_eq "$(echo "$SPAN" | jq -r '.parentSpanId')" "$PARENT_SPAN_ID" "span parent"
assert_eq "$(echo "$SPAN" | jq -r '.kind')" "3" "span kind should be CLIENT (3)"
assert_eq "$(echo "$SPAN" | jq -r '.status.code')" "0" "span status should be UNSET"
assert_eq "$(echo "$SPAN" | jq -r '.attributes["mcp.method.name"]')" "tools/call" "mcp.method.name"
assert_eq "$(echo "$SPAN" | jq -r '.attributes["gen_ai.operation.name"]')" "execute_tool" "gen_ai.operation.name"
assert_eq "$(echo "$SPAN" | jq -r '.attributes["gen_ai.tool.name"]')" "echo" "gen_ai.tool.name"
assert_eq "$(echo "$SPAN" | jq -r '.attributes["mcp.protocol.version"]')" "$EXPECTED_PROTOCOL" "mcp.protocol.version"
assert_eq "$(echo "$SPAN" | jq -r '.attributes["server.address"]')" "localhost" "server.address"
assert_eq "$(echo "$SPAN" | jq -r '.attributes["server.port"]')" "$TEST_SERVER_PORT" "server.port"
assert_eq "$(echo "$SPAN" | jq -r '.attributes["network.transport"]')" "tcp" "network.transport"
assert_eq "$(echo "$SPAN" | jq -r '.resource["service.name"]')" "mcpc-e2e" "OTEL_SERVICE_NAME should name the resource"
assert_eq "$(echo "$SPAN" | jq -r '.scope.name')" "@apify/mcpc" "instrumentation scope"
# Spans never record tool arguments
assert_not_contains "$SPAN" "traced"
test_pass

test_case "a failed tool call is an error span"
run_mcpc "$SESSION" tools-call fail
assert_exit_code 2
if ! wait_for "otlp_spans | jq -e '.spans[] | select(.name == \"tools/call fail\")' >/dev/null" 20; then
  test_fail "tools/call fail span was not exported"
  exit 1
fi
FAIL_SPAN=$(otlp_spans | jq -c '[.spans[] | select(.name == "tools/call fail")] | last')
assert_eq "$(echo "$FAIL_SPAN" | jq -r '.status.code')" "2" "span status should be ERROR"
assert_not_empty "$(echo "$FAIL_SPAN" | jq -r '.attributes["error.type"] // ""')" "error.type should be set"
test_pass

test_case "duration metric is recorded per method and tool"
if ! wait_for "otlp_metrics | jq -e '.points[] | select(.name == \"mcp.client.operation.duration\" and .attributes[\"mcp.method.name\"] == \"tools/call\" and .attributes[\"gen_ai.tool.name\"] == \"echo\")' >/dev/null" 20; then
  test_fail "no mcp.client.operation.duration point for tools/call echo (points: $(otlp_metrics | jq -c '[.points[] | .attributes["mcp.method.name"]] | unique'))"
  exit 1
fi
POINT=$(otlp_metrics | jq -c '[.points[] | select(.name == "mcp.client.operation.duration" and .attributes["mcp.method.name"] == "tools/call" and .attributes["gen_ai.tool.name"] == "echo")] | last')
assert_eq "$(echo "$POINT" | jq -r '.unit')" "s" "histogram unit"
assert_eq "$(echo "$POINT" | jq -r '.explicitBounds | length')" "14" "MCP semantic-convention bucket boundaries"
# Metrics never carry session ids, request ids or resource URIs
assert_eq "$(echo "$POINT" | jq -r '.attributes | has("mcp.session.id") or has("jsonrpc.request.id")')" "false" "no high-cardinality metric attributes"
test_pass

# =============================================================================
# Restart and close
# =============================================================================

test_case "restart keeps exporting and flushes on close"
# Batch spans for a minute: only the shutdown flush can deliver them now
OTEL_BSP_SCHEDULE_DELAY=60000 run_mcpc "$SESSION" restart
assert_success
assert_contains "$STDOUT" "Telemetry: OpenTelemetry"
otlp_reset
run_mcpc "$SESSION" tools-call add a:=1 b:=2
assert_success
sleep 1
if otlp_spans | jq -e '.spans[] | select(.name == "tools/call add")' >/dev/null; then
  test_fail "tools/call add span was exported before the batch delay or close"
  exit 1
fi
run_mcpc "$SESSION" close
assert_success
if ! wait_for "otlp_spans | jq -e '.spans[] | select(.name == \"tools/call add\")' >/dev/null" 15; then
  test_fail "close should flush the pending tools/call add span"
  exit 1
fi
test_pass

# =============================================================================
# Without --otel
# =============================================================================

test_case "without --otel the trace context stays out of _meta"
run_mcpc connect "$TEST_SERVER_URL" "$PLAIN_SESSION"
assert_success
_SESSIONS_CREATED+=("$PLAIN_SESSION")
assert_not_contains "$STDOUT" "Telemetry:"
curl -s -X POST "$TEST_SERVER_URL/control/reset" >/dev/null
TRACEPARENT="$CALLER_TRACEPARENT" run_mcpc "$PLAIN_SESSION" tools-call echo message:=plain
assert_success
assert_eq "$(curl -s "$TEST_SERVER_URL/control/get-last-tool-call-meta" | jq -r '.meta.traceparent // "absent"')" "absent" "_meta.traceparent must not be sent without --otel"
run_mcpc --json
assert_eq "$(json_get ".sessions[] | select(.name == \"$PLAIN_SESSION\") | .otel // \"absent\"")" "absent" "otel flag should be absent"
test_pass

test_done
