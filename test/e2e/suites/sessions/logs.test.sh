#!/bin/bash
# Test: `mcpc @<session> logs` command
#
# Covers:
#   - error when session does not exist
#   - default output (last 50 lines, header on stderr, lines on stdout)
#   - --json produces parsed records, banners become {raw}
#   - -n / --tail caps output
#   - --since filters by timestamp; invalid value rejected
#   - --tail and --since combine
#   - rotation files (.log.1, .log.2) are spanned when more lines are needed
#   - _mcpc.logPath appears in `mcpc @<session> --json`
#   - error messages from a real failing session point users at `mcpc <name> logs`

source "$(dirname "$0")/../../lib/framework.sh"
test_init "sessions/logs" --isolated

start_test_server

SESSION=$(session_name "logs")
_SESSIONS_CREATED+=("$SESSION")

# Real connect so the session exists in sessions.json and the bridge log
# file gets created with at least the startup banner.
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success "connect should succeed"

# =============================================================================
# Error: session does not exist
# =============================================================================

test_case "logs on unknown session fails with helpful error"
NONEXISTENT="@nope-$(date +%s)"
run_mcpc "$NONEXISTENT" logs
assert_failure
assert_contains "$STDERR" "Session not found"
assert_contains "$STDERR" "$NONEXISTENT"
test_pass

# =============================================================================
# Error: invalid --since value
# =============================================================================

test_case "invalid --since value is rejected"
run_mcpc "$SESSION" logs --since not-a-duration
assert_failure
assert_contains "$STDERR" "Invalid --since value"
test_pass

# =============================================================================
# Default human output
# =============================================================================

test_case "default logs prints header on stderr and lines on stdout"
run_mcpc "$SESSION" logs
assert_success
# Header (path + tail label) goes to stderr. Match the log file's basename
# rather than the full path: mcpc resolves the path from MCPC_HOME_DIR via
# Node, which diverges from the bash-side value on Windows (MSYS rewrites
# /tmp to a native C:\...\Temp path) and macOS (path.resolve collapses
# TMPDIR's trailing slash). The basename uniquely identifies this session's
# log file and is portable across platforms.
assert_contains "$STDERR" "bridge-${SESSION}.log"
assert_contains "$STDERR" "last 50 lines"
# At least one log line on stdout (bridge writes a startup banner + version line)
if [[ -z "$STDOUT" ]]; then
  test_fail "expected at least one log line on stdout, got empty"
  exit 1
fi
test_pass

# =============================================================================
# --json shape
# =============================================================================

test_case "--json returns array of structured records"
run_mcpc --json "$SESSION" logs
assert_success
assert_json_valid "$STDOUT"
# Should be a non-empty array
arr_len=$(echo "$STDOUT" | jq 'length')
if [[ "$arr_len" -lt 1 ]]; then
  test_fail "expected at least one log record, got $arr_len"
  exit 1
fi
# Records that match the [time] [LEVEL] [ctx?] msg shape have `time` populated;
# banner separators don't and surface as `{ raw: "..." }` instead.
parsed_count=$(echo "$STDOUT" | jq '[.[] | select(.time != null)] | length')
raw_count=$(echo "$STDOUT" | jq '[.[] | select(.raw != null)] | length')
if [[ "$parsed_count" -lt 1 ]]; then
  test_fail "expected at least one parsed record with .time set, got $parsed_count"
  exit 1
fi
# Either format is acceptable, but the union should equal total length.
total=$(( parsed_count + raw_count ))
if [[ "$total" -ne "$arr_len" ]]; then
  test_fail "every record should have either .time or .raw, got parsed=$parsed_count raw=$raw_count total=$arr_len"
  exit 1
fi
# Parsed records should expose the documented fields.
first_parsed=$(echo "$STDOUT" | jq '[.[] | select(.time != null)][0]')
assert_contains "$first_parsed" '"level"'
assert_contains "$first_parsed" '"context"'
assert_contains "$first_parsed" '"msg"'
test_pass

# =============================================================================
# -n / --tail caps output
# =============================================================================

test_case "-n 1 returns exactly 1 record in JSON"
run_mcpc --json "$SESSION" logs -n 1
assert_success
arr_len=$(echo "$STDOUT" | jq 'length')
if [[ "$arr_len" -ne 1 ]]; then
  test_fail "expected 1 record with -n 1, got $arr_len"
  exit 1
fi
test_pass

test_case "--tail 2 returns exactly 2 records in JSON"
run_mcpc --json "$SESSION" logs --tail 2
assert_success
arr_len=$(echo "$STDOUT" | jq 'length')
if [[ "$arr_len" -ne 2 ]]; then
  test_fail "expected 2 records with --tail 2, got $arr_len"
  exit 1
fi
test_pass

test_case "invalid -n value is rejected"
run_mcpc "$SESSION" logs -n not-a-number
assert_failure
assert_contains "$STDERR" "Invalid"
test_pass

# =============================================================================
# --since filters by timestamp
# =============================================================================

# An ISO timestamp far in the future should yield zero records (well, zero
# parseable records — banners with no timestamp survive the filter).
test_case "--since in the future yields no parseable records"
run_mcpc --json "$SESSION" logs --since 2099-01-01T00:00:00Z
assert_success
parsed_count=$(echo "$STDOUT" | jq '[.[] | select(.time != null)] | length')
if [[ "$parsed_count" -ne 0 ]]; then
  test_fail "expected 0 parsed records after filtering with future --since, got $parsed_count"
  exit 1
fi
test_pass

# A duration that covers everything written so far should keep all records.
test_case "--since 1d keeps all recent records"
run_mcpc --json "$SESSION" logs --since 1d
assert_success
arr_len=$(echo "$STDOUT" | jq 'length')
if [[ "$arr_len" -lt 1 ]]; then
  test_fail "expected --since 1d to retain recent records, got $arr_len"
  exit 1
fi
test_pass

# =============================================================================
# JSON folding: stack-trace continuation lines attach to the preceding entry
#
# Uses a fresh, never-connected session so the bridge isn't writing to the file
# while we inject deterministic content with a multi-line error.
# =============================================================================

FOLD_SESSION="@fold-$(date +%s)"
_SESSIONS_CREATED+=("$FOLD_SESSION")
edit_sessions_json --arg name "$FOLD_SESSION" --arg url "$TEST_SERVER_URL" \
  '.sessions[$name] = { name: $name, server: { url: $url }, transport: "http", status: "live", createdAt: "2026-04-28T00:00:00.000Z" }'

mkdir -p "$MCPC_HOME_DIR/logs"
cat > "$MCPC_HOME_DIR/logs/bridge-${FOLD_SESSION}.log" <<'FOLDLOG'
[2026-04-28T10:00:00.000Z] [ERROR] [McpClient] Transport error: terminated
    at processStream (file:///x/streamableHttp.js:233:32)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)
[2026-04-28T10:00:01.000Z] [INFO] [bridge] recovered
FOLDLOG

test_case "stack-trace lines fold into the preceding JSON record"
run_mcpc --json "$FOLD_SESSION" logs
assert_success
# Two entries, not four: the two stack frames fold into the error's msg.
arr_len=$(echo "$STDOUT" | jq 'length')
assert_eq "$arr_len" "2" "expected stack frames to fold into the error entry"
first_msg=$(echo "$STDOUT" | jq -r '.[0].msg')
assert_contains "$first_msg" "Transport error: terminated"
assert_contains "$first_msg" "at processStream"
assert_contains "$first_msg" "at process.processTicksAndRejections"
second_msg=$(echo "$STDOUT" | jq -r '.[1].msg')
assert_eq "$second_msg" "recovered" "second record should be the standalone info entry"
test_pass

# =============================================================================
# Rotation: tail spans .log.1, .log.2 transparently
#
# We use a fresh, never-connected session so the bridge isn't actively writing
# to the log file while we inject fixture content. The session entry has to
# exist in sessions.json (otherwise `logs` would error) but never needs a
# running bridge — the command just reads the on-disk files.
# =============================================================================

ROTATION_SESSION="@rot-$(date +%s)"
_SESSIONS_CREATED+=("$ROTATION_SESSION")

# Add a synthetic session entry so `mcpc logs` accepts the target.
edit_sessions_json --arg name "$ROTATION_SESSION" --arg url "$TEST_SERVER_URL" \
  '.sessions[$name] = {
     name: $name,
     server: { url: $url },
     transport: "http",
     status: "live",
     createdAt: "2026-04-28T00:00:00.000Z"
   }'

ROT_LOG_DIR="$MCPC_HOME_DIR/logs"
ROT_LOG_FILE="$ROT_LOG_DIR/bridge-${ROTATION_SESSION}.log"
mkdir -p "$ROT_LOG_DIR"

cat > "$ROT_LOG_DIR/bridge-${ROTATION_SESSION}.log.2" <<'OLDER'
[2026-04-28T08:00:00.000Z] [INFO] [test] r2-line-a
[2026-04-28T08:00:01.000Z] [INFO] [test] r2-line-b
OLDER
cat > "$ROT_LOG_DIR/bridge-${ROTATION_SESSION}.log.1" <<'OLD'
[2026-04-28T09:00:00.000Z] [INFO] [test] r1-line-a
[2026-04-28T09:00:01.000Z] [INFO] [test] r1-line-b
[2026-04-28T09:00:02.000Z] [INFO] [test] r1-line-c
OLD
cat > "$ROT_LOG_FILE" <<'CUR'
[2026-04-28T10:00:00.000Z] [INFO] [test] cur-line-a
[2026-04-28T10:00:01.000Z] [INFO] [test] cur-line-b
CUR

test_case "tail spans rotated log files"
# tail 4 should return the LAST 4 lines (chronological order):
#   r1-line-b, r1-line-c, cur-line-a, cur-line-b
run_mcpc --json "$ROTATION_SESSION" logs -n 4
assert_success
arr_len=$(echo "$STDOUT" | jq 'length')
assert_eq "$arr_len" "4" "expected exactly 4 records with -n 4"
got=$(echo "$STDOUT" | jq -r '[.[] | .msg] | join(",")')
assert_contains "$got" "r1-line-b"
assert_contains "$got" "r1-line-c"
assert_contains "$got" "cur-line-a"
assert_contains "$got" "cur-line-b"
# r2-line-* should NOT appear (older than the tail window)
if echo "$got" | grep -q "r2-line"; then
  test_fail "r2-line-* should not appear in tail 4 result, got: $got"
  exit 1
fi
test_pass

test_case "tail larger than total reads everything across rotations"
run_mcpc --json "$ROTATION_SESSION" logs -n 1000
assert_success
got=$(echo "$STDOUT" | jq -r '[.[] | .msg // .raw] | join("|")')
# All injected lines should appear, in order.
assert_contains "$got" "r2-line-a"
assert_contains "$got" "r2-line-b"
assert_contains "$got" "r1-line-a"
assert_contains "$got" "cur-line-b"
# Order: oldest-first across files
expected_order=("r2-line-a" "r2-line-b" "r1-line-a" "r1-line-b" "r1-line-c" "cur-line-a" "cur-line-b")
prev_idx=-1
for marker in "${expected_order[@]}"; do
  idx=$(echo "$got" | grep -bo "$marker" | head -1 | cut -d: -f1)
  if [[ -z "$idx" ]]; then
    test_fail "missing marker '$marker' in output: $got"
    exit 1
  fi
  if [[ "$idx" -le "$prev_idx" ]]; then
    test_fail "marker '$marker' appears out of order in: $got"
    exit 1
  fi
  prev_idx=$idx
done
test_pass

test_case "--since spans rotated files"
run_mcpc --json "$ROTATION_SESSION" logs --since 2026-04-28T08:30:00.000Z
assert_success
got=$(echo "$STDOUT" | jq -r '[.[] | .msg] | join(",")')
# r2-line-a is before the cutoff and should be filtered out
if echo "$got" | grep -q "r2-line-a"; then
  test_fail "r2-line-a should be filtered out by --since, got: $got"
  exit 1
fi
# r1-line-* and cur-line-* are after the cutoff
assert_contains "$got" "r1-line-a"
assert_contains "$got" "cur-line-b"
test_pass

# =============================================================================
# `mcpc @<session> --json` exposes _mcpc.logPath
# =============================================================================

test_case "session JSON exposes _mcpc.logPath"
run_mcpc --json "$SESSION"
assert_success
log_path=$(echo "$STDOUT" | jq -r '._mcpc.logPath // empty')
if [[ -z "$log_path" ]]; then
  test_fail "expected _mcpc.logPath in session JSON output"
  exit 1
fi
assert_contains "$log_path" "bridge-${SESSION}.log"
test_pass

# =============================================================================
# Error messages now point users at the new logs command
# =============================================================================

test_case "error from broken session points to 'mcpc <session> logs'"
# Use an explicitly-named session (not derived from session_name() which
# already has an @) since session names can only contain one @ at the start.
BROKEN="@broken-$(date +%s)-$$"
# Add a manually-crafted session entry pointing at a server that 401s.
edit_sessions_json --arg name "$BROKEN" --arg url "$TEST_SERVER_URL" \
  '.sessions[$name] = {
     name: $name,
     server: { url: $url, headers: { "Authorization": "InvalidScheme bogus" } },
     transport: "http",
     status: "unauthorized",
     createdAt: "2026-04-28T00:00:00.000Z"
   }'
_SESSIONS_CREATED+=("$BROKEN")

run_mcpc "$BROKEN" tools-list
assert_failure
assert_contains "$STDERR" "mcpc ${BROKEN} logs"
test_pass

test_done
