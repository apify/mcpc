#!/bin/bash
# E2E Test Runner for mcpc
#
# Usage:
#   ./run.sh                    # Run all tests in parallel
#   ./run.sh basic/             # Run all tests in a suite
#   ./run.sh basic/help.test.sh # Run specific test
#   ./run.sh -p 1 basic/        # Run sequentially (parallel=1)
#
# Options:
#   -p, --parallel N   Max parallel tests (default: 16)
#   -s, --server-protocol <p>  Test server protocol era: legacy (default) or modern
#   -i, --isolated     Force all tests to use isolated home directories
#   -c, --coverage     Collect code coverage
#   -k, --keep         Keep test run directory after tests
#   -v, --verbose      Show test output as it runs
#   -l, --list         List available tests without running
#   -h, --help         Show help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Default options
PARALLEL=16
ISOLATED_ALL=false
COVERAGE=false
KEEP_RUNS=false
VERBOSE=false
LIST_ONLY=false
SKIP_BUILD=false
RUNTIME="node"
SERVER_PROTOCOL="${E2E_SERVER_PROTOCOL:-legacy}"
PATTERNS=()

# Per-test timeout (seconds). A single hung test (e.g. an mcpc invocation that
# never exits) must never stall the whole run: without a timeout it blocks the
# parallel runner indefinitely and the CI job keeps going until GitHub's 6h hard
# kill — and because results are only printed after every test finishes, the log
# never even reveals which test hung (observed on macOS/Bun). The watchdog kills
# the offending test, records a failure, and lets the suite finish and name it.
# Override with E2E_PER_TEST_TIMEOUT for slower environments.
PER_TEST_TIMEOUT="${E2E_PER_TEST_TIMEOUT:-180}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
DIM='\033[0;2m'
NC='\033[0m'

# Cross-platform helpers
_UNAME_S="$(uname -s)"
_is_windows() {
  [[ "$_UNAME_S" == MINGW* || "$_UNAME_S" == MSYS* ]]
}
_TMPDIR="${TMPDIR:-${TEMP:-/tmp}}"

# Current time in milliseconds. Used to report per-test durations, which are the
# only way to see which tests dominate a run (results are printed after all tests
# finish, so the log order says nothing about cost).
_now_millis() {
  local ns
  ns=$(date +%s%N 2>/dev/null)
  # `date +%N` is a GNU extension; fall back to second resolution elsewhere.
  if [[ "$ns" == *N* || -z "$ns" ]]; then
    echo $(( $(date +%s) * 1000 ))
  else
    echo $(( ns / 1000000 ))
  fi
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -p|--parallel)
      PARALLEL="$2"
      shift 2
      ;;
    -i|--isolated)
      ISOLATED_ALL=true
      shift
      ;;
    -c|--coverage)
      COVERAGE=true
      shift
      ;;
    -k|--keep)
      KEEP_RUNS=true
      shift
      ;;
    -v|--verbose)
      VERBOSE=true
      shift
      ;;
    -l|--list)
      LIST_ONLY=true
      shift
      ;;
    -r|--runtime)
      RUNTIME="$2"
      shift 2
      ;;
    -s|--server-protocol)
      SERVER_PROTOCOL="$2"
      shift 2
      ;;
    -b|--no-build)
      SKIP_BUILD=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [options] [pattern...]"
      echo ""
      echo "Options:"
      echo "  -p, --parallel N   Max parallel tests (default: 16)"
      echo "  -r, --runtime <r>  Runtime for mcpc: node (default) or bun"
      echo "  -s, --server-protocol <p>  Test server protocol era: legacy (default, MCP 2025-11-25)"
      echo "                     or modern (MCP 2026-07-28); era-specific tests are skipped"
      echo "  -i, --isolated     Force all tests to use isolated home directories"
      echo "  -c, --coverage     Collect code coverage"
      echo "  -b, --no-build     Skip building mcpc (assumes dist/ is up to date)"
      echo "  -k, --keep         Keep test run directory after tests"
      echo "  -v, --verbose      Show test output as it runs"
      echo "  -l, --list         List available tests without running"
      echo "  -h, --help         Show help"
      echo ""
      echo "Patterns:"
      echo "  basic/             Run all tests in the 'basic' suite"
      echo "  basic/help.test.sh Run specific test file"
      echo "  (no pattern)       Run all tests"
      echo ""
      echo "Available test suites:"
      for suite in "$SCRIPT_DIR"/suites/*/; do
        suite_name=$(basename "$suite")
        test_count=$(find "$suite" -name "*.test.sh" 2>/dev/null | wc -l | tr -d ' ')
        if [[ $test_count -gt 0 ]]; then
          echo "  $suite_name/ ($test_count tests)"
        fi
      done
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
    *)
      PATTERNS+=("$1")
      shift
      ;;
  esac
done

# Suites directory
SUITES_DIR="$SCRIPT_DIR/suites"

# Find all test files matching patterns (outputs newline-separated paths)
find_tests() {
  if [[ ${#PATTERNS[@]} -eq 0 ]]; then
    # No pattern - find all tests in suites/
    find "$SUITES_DIR" -name "*.test.sh" | sort
  else
    for pattern in "${PATTERNS[@]}"; do
      if [[ -f "$SUITES_DIR/$pattern" ]]; then
        # Specific file
        echo "$SUITES_DIR/$pattern"
      elif [[ -d "$SUITES_DIR/$pattern" ]]; then
        # Directory - find all tests in it
        find "$SUITES_DIR/$pattern" -name "*.test.sh" | sort
      elif [[ -d "$SUITES_DIR/${pattern%/}" ]]; then
        # Directory without trailing slash
        find "$SUITES_DIR/${pattern%/}" -name "*.test.sh" | sort
      else
        echo "Warning: No tests match pattern: $pattern" >&2
      fi
    done
  fi
}

# Get test name from path (relative to suites dir, without .test.sh)
test_name() {
  local path="$1"
  local rel="${path#$SUITES_DIR/}"
  echo "${rel%.test.sh}"
}

# Collect tests
TESTS=()
while IFS= read -r test; do
  [[ -n "$test" ]] && TESTS+=("$test")
done <<< "$(find_tests)"

if [[ ${#TESTS[@]} -eq 0 ]]; then
  echo "No tests found" >&2
  exit 1
fi

# Validate runtime and resolve version string
case "$RUNTIME" in
  node)
    RUNTIME_VERSION="node $(node --version)"
    ;;
  bun)
    if ! command -v bun &>/dev/null; then
      echo "bun is not installed; skipping bun runtime tests"
      exit 0
    fi
    RUNTIME_VERSION="bun $(bun --version)"
    ;;
  *)
    echo "Unknown runtime: $RUNTIME (valid options: node, bun)" >&2
    exit 1
    ;;
esac
export E2E_RUNTIME="$RUNTIME"

# Validate test-server protocol era
case "$SERVER_PROTOCOL" in
  legacy|modern) ;;
  *)
    echo "Unknown server protocol: $SERVER_PROTOCOL (valid options: legacy, modern)" >&2
    exit 1
    ;;
esac
export E2E_SERVER_PROTOCOL="$SERVER_PROTOCOL"

# List mode
if [[ "$LIST_ONLY" == "true" ]]; then
  echo "Available tests:"
  for test in "${TESTS[@]}"; do
    echo "  $(test_name "$test")"
  done
  echo ""
  echo "Total: ${#TESTS[@]} tests"
  exit 0
fi

# Generate unique run ID
export E2E_RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
export E2E_RUNS_DIR="$PROJECT_ROOT/test/runs"

# Create run directory
RUN_DIR="$E2E_RUNS_DIR/$E2E_RUN_ID"
mkdir -p "$RUN_DIR"

echo -e "${BLUE}════════════════════════════════════════${NC}"
echo -e "${BLUE}mcpc E2E Tests${NC}"
echo -e "${BLUE}════════════════════════════════════════${NC}"
echo ""
echo "Run ID:    $E2E_RUN_ID"
echo "Run dir:   $RUN_DIR"
echo "Tests:     ${#TESTS[@]}"
echo "Parallel:  $PARALLEL"
echo "Runtime:   $RUNTIME_VERSION"
echo "Server:    $SERVER_PROTOCOL protocol ($([[ "$SERVER_PROTOCOL" == "modern" ]] && echo "MCP 2026-07-28" || echo "MCP 2025-11-25"))"
if [[ "$ISOLATED_ALL" == "true" ]]; then
  echo "Home dirs: isolated (per-test)"
else
  echo "Home dir:  $RUN_DIR/_shared_home"
fi
if [[ "$COVERAGE" == "true" ]]; then
  echo "Coverage:  enabled"
fi
echo ""

# Set up isolated mode environment variable
if [[ "$ISOLATED_ALL" == "true" ]]; then
  export E2E_ISOLATED_ALL=1
fi

# Shared home directory uses temp dir to keep socket paths short
# (Unix socket paths are limited to ~104 bytes)
E2E_SHARED_HOME="$_TMPDIR/mcpc-e2e-$E2E_RUN_ID"
mkdir -p "$E2E_SHARED_HOME"
export E2E_SHARED_HOME
# Create a symlink in run directory for easy access (skip on Windows where symlinks need privileges)
if ! _is_windows; then
  ln -sf "$E2E_SHARED_HOME" "$RUN_DIR/_shared_home"
fi

# Set up coverage collection if enabled
if [[ "$COVERAGE" == "true" ]]; then
  export NODE_V8_COVERAGE="$RUN_DIR/v8-coverage"
  mkdir -p "$NODE_V8_COVERAGE"
fi

# Build mcpc first (unless skipped)
if [[ "$SKIP_BUILD" == "true" ]]; then
  echo -e "${DIM}Skipping build (--no-build)${NC}"
else
  echo -e "${DIM}Building mcpc...${NC}"
  cd "$PROJECT_ROOT"
  if ! npm run build >/dev/null 2>&1; then
    echo -e "${RED}Build failed${NC}" >&2
    npm run build
    exit 1
  fi
  echo -e "${GREEN}Build complete${NC}"
fi
echo ""

# Print the pids of all descendants of a given pid (recursively).
# Used to locate the hung mcpc invocation under a timed-out test shell.
_descendant_pids() {
  local p="$1" c
  for c in $(pgrep -P "$p" 2>/dev/null); do
    echo "$c"
    _descendant_pids "$c"
  done
}

# Capture the state of a hung test's process tree, so a timeout produces an
# actionable failure log instead of an opaque "killed". Best-effort throughout.
# Writes to stdout; the caller redirects it to a side file (the test is still
# running and writing to its own output.log, so we must not race it there).
_capture_timeout_diagnostics() {
  local test_pid="$1" test_id="$2" test_dir="$3"
  local kids
  kids=$(_descendant_pids "$test_pid")

  echo ""
  echo "----- TIMEOUT DIAGNOSTICS: $test_id (test pid $test_pid) -----"

  echo "--- hung test process tree ---"
  # shellcheck disable=SC2086
  ps -ww -o pid,ppid,etime,command -p "$test_pid" $kids 2>/dev/null | head -40 || true

  echo "--- all mcpc CLI / bridge processes ---"
  ps -axww -o pid,etime,command 2>/dev/null \
    | grep -E "dist/cli/index|dist/bridge/index|mcpc-bridge" | grep -v grep | head -30 || true

  # Native stack of each hung descendant. macOS `sample` needs no privileges for
  # own-user processes and pinpoints the exact syscall/frame the process is stuck on.
  if command -v sample >/dev/null 2>&1; then
    for pid in $kids; do
      echo "--- sample pid=$pid ---"
      sample "$pid" 1 2>/dev/null | sed -n '1,60p' || true
    done
  fi

  # Per-test bridge logs. framework.sh prints the home dir in the test header
  # ("# Home dir: <path> (<mode>)"), so recover it from the test's own output.
  local home
  home=$(grep -m1 '^# Home dir:' "$test_dir/output.log" 2>/dev/null \
    | sed -e 's/^# Home dir: //' -e 's/ ([a-z]*)$//')
  echo "--- bridge logs in: ${home:-?}/logs ---"
  if [[ -n "$home" && -d "$home/logs" ]]; then
    for f in "$home"/logs/bridge-*.log; do
      [[ -f "$f" ]] || continue
      echo "### $(basename "$f")"
      tail -60 "$f" 2>/dev/null || true
    done
  fi
  echo "----- END DIAGNOSTICS -----"
}

# Function to run a single test (with a per-test timeout watchdog)
run_test() {
  local test_path="$1"
  local test_id
  test_id=$(test_name "$test_path")
  local test_dir="$E2E_RUNS_DIR/$E2E_RUN_ID/$test_id"

  # Ensure test directory exists (framework.sh creates it, but be safe)
  mkdir -p "$test_dir"

  local started_at
  started_at=$(_now_millis)

  # Run the test in the background so a watchdog can enforce PER_TEST_TIMEOUT.
  # A hung test would otherwise block the parallel runner forever; this guarantees
  # the run always terminates and the failure log points at the culprit.
  bash "$test_path" > "$test_dir/output.log" 2>&1 &
  local test_pid=$!
  local timeout_marker="$test_dir/.timed_out"
  rm -f "$timeout_marker"

  (
    sleep "$PER_TEST_TIMEOUT"
    # Only act if the test is still running. Drop a marker (so run_test can label
    # the failure once the process is dead and no longer writing to output.log),
    # then kill the test's direct children (mcpc, test server) and the test shell.
    # Detached bridge processes are reaped by the end-of-run cleanup.
    if kill -0 "$test_pid" 2>/dev/null; then
      : > "$timeout_marker"
      # Capture the hung process tree's state while it's still alive. Written to a
      # side file (not output.log) to avoid racing the test's own final writes;
      # run_test appends it after the kill.
      _capture_timeout_diagnostics "$test_pid" "$test_id" "$test_dir" \
        > "$test_dir/.timeout_diag" 2>&1 || true
      pkill -P "$test_pid" 2>/dev/null || true
      kill -9 "$test_pid" 2>/dev/null || true
    fi
  ) &
  local watchdog_pid=$!

  # Capture the test's exit code without tripping `set -e`; a killed test reports
  # non-zero, which is recorded as a failure.
  local result=0
  wait "$test_pid" || result=$?

  # Test finished (or was killed) — stop the watchdog and reap it.
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true

  # If the watchdog tripped, the test process is now dead, so appending the
  # timeout notice here is free of the write race that would clobber it if the
  # watchdog wrote while the dying test was still flushing its own output.
  if [[ -f "$timeout_marker" ]]; then
    {
      echo ""
      echo "TIMEOUT: test '$test_id' exceeded ${PER_TEST_TIMEOUT}s limit (killed by run.sh watchdog)"
      [[ -f "$test_dir/.timeout_diag" ]] && cat "$test_dir/.timeout_diag"
    } >> "$test_dir/output.log"
    rm -f "$timeout_marker" "$test_dir/.timeout_diag"
    result=137
  fi

  echo "$result" > "$test_dir/result"
  echo "$(( $(_now_millis) - started_at ))" > "$test_dir/duration_millis"
}

export SCRIPT_DIR SUITES_DIR E2E_RUN_ID E2E_RUNS_DIR E2E_SHARED_HOME E2E_ISOLATED_ALL E2E_RUNTIME E2E_SERVER_PROTOCOL PROJECT_ROOT NODE_V8_COVERAGE PER_TEST_TIMEOUT

# Run tests
echo -e "${BLUE}Running tests...${NC}"
echo ""

if [[ "$VERBOSE" == "true" ]]; then
  # Sequential with output shown in real-time
  for test in "${TESTS[@]}"; do
    name=$(test_name "$test")
    test_dir="$RUN_DIR/$name"
    mkdir -p "$test_dir"

    echo -e "${DIM}Running: $name${NC}"
    _started_at=$(_now_millis)
    # Run test, show output in real-time, and save to file
    if bash "$test" 2>&1 | tee "$test_dir/output.log"; then
      echo "0" > "$test_dir/result"
      echo -e "${GREEN}✓${NC} $name"
    else
      echo "${PIPESTATUS[0]}" > "$test_dir/result"
      echo -e "${RED}✗${NC} $name"
    fi
    echo "$(( $(_now_millis) - _started_at ))" > "$test_dir/duration_millis"
  done
elif _is_windows; then
  # On Windows, export -f is unreliable in Git Bash, so use background jobs.
  # Each test gets a timeout (PER_TEST_TIMEOUT) to prevent indefinite hangs.
  _PER_TEST_TIMEOUT="$PER_TEST_TIMEOUT"
  _running=0
  for test in "${TESTS[@]}"; do
    test_id=$(test_name "$test")
    test_dir="$E2E_RUNS_DIR/$E2E_RUN_ID/$test_id"
    mkdir -p "$test_dir"
    (
      _started_at=$(_now_millis)
      # Run test with a timeout: start test in background, kill if it exceeds limit
      bash "$test" > "$test_dir/output.log" 2>&1 &
      _test_pid=$!
      (
        sleep "$_PER_TEST_TIMEOUT"
        echo "TIMEOUT: test '$test_id' exceeded ${_PER_TEST_TIMEOUT}s limit" >> "$test_dir/output.log"
        kill -9 "$_test_pid" 2>/dev/null || true
      ) &
      _watchdog_pid=$!
      if wait "$_test_pid" 2>/dev/null; then
        echo "0" > "$test_dir/result"
      else
        echo "${?:-1}" > "$test_dir/result"
      fi
      kill "$_watchdog_pid" 2>/dev/null || true
      wait "$_watchdog_pid" 2>/dev/null || true
      echo "$(( $(_now_millis) - _started_at ))" > "$test_dir/duration_millis"
    ) &
    ((_running++)) || true
    if [[ $_running -ge $PARALLEL ]]; then
      wait -n 2>/dev/null || wait
      ((_running--)) || true
    fi
  done
  wait
else
  # Parallel execution via xargs (Unix)
  export -f run_test test_name _capture_timeout_diagnostics _descendant_pids _now_millis
  printf '%s\n' "${TESTS[@]}" | xargs -P "$PARALLEL" -I {} bash -c 'run_test "$@"' _ {}
fi

# Collect and display results
echo ""
echo -e "${BLUE}════════════════════════════════════════${NC}"
echo -e "${BLUE}Results${NC}"
echo -e "${BLUE}════════════════════════════════════════${NC}"
echo ""

PASSED=0
FAILED=0
SKIPPED=0
FAILED_TESTS=()
DURATIONS=()

# Format a duration in milliseconds as a compact human string (e.g. "1.4s")
_format_millis() {
  local ms="$1"
  if [[ $ms -lt 1000 ]]; then
    echo "${ms}ms"
  else
    echo "$((ms / 1000)).$(( (ms % 1000) / 100 ))s"
  fi
}

for test in "${TESTS[@]}"; do
  test_id=$(test_name "$test")
  test_dir="$RUN_DIR/$test_id"
  result_file="$test_dir/result"

  duration_millis=""
  [[ -f "$test_dir/duration_millis" ]] && duration_millis=$(cat "$test_dir/duration_millis")
  duration_label=""
  if [[ -n "$duration_millis" ]]; then
    duration_label=" ${DIM}($(_format_millis "$duration_millis"))${NC}"
    DURATIONS+=("$duration_millis $test_id")
  fi

  if [[ -f "$result_file" ]]; then
    result=$(cat "$result_file")
    # A suite that skipped itself (skip_suite / require_server_protocol) exits 0 but
    # ran nothing — report it as skipped so a whole missing matrix column can't look green
    if [[ "$result" == "0" && -f "$test_dir/.skipped" ]]; then
      echo -e "${YELLOW}⊘${NC} $test_id ${DIM}($(cat "$test_dir/.skipped"))${NC}"
      ((SKIPPED++)) || true
    elif [[ "$result" == "0" ]]; then
      echo -e "${GREEN}✓${NC} $test_id$duration_label"
      ((PASSED++)) || true
    else
      echo -e "${RED}✗${NC} $test_id (exit code: $result)$duration_label"
      ((FAILED++)) || true
      FAILED_TESTS+=("$test_id")
    fi
  else
    echo -e "${YELLOW}?${NC} $test_id (no result)"
    ((FAILED++)) || true
    FAILED_TESTS+=("$test_id")
  fi
done

# Summary
echo ""
echo -e "${BLUE}────────────────────────────────────────${NC}"
echo "Total:   $((PASSED + FAILED + SKIPPED))"
echo -e "Passed:  ${GREEN}$PASSED${NC}"
echo -e "Skipped: ${YELLOW}$SKIPPED${NC}"
echo -e "Failed:  ${RED}$FAILED${NC}"

# Slowest tests, so a slowdown is visible in the CI log without extra tooling
if [[ ${#DURATIONS[@]} -gt 0 ]]; then
  echo ""
  echo "Slowest tests:"
  printf '%s\n' "${DURATIONS[@]}" | sort -rn | head -10 | while read -r ms id; do
    echo -e "  ${DIM}$(_format_millis "$ms")\t$id${NC}"
  done
fi

# Show failed test logs
if [[ ${#FAILED_TESTS[@]} -gt 0 ]]; then
  echo ""
  echo -e "${RED}Failed test logs:${NC}"
  for test_id in "${FAILED_TESTS[@]}"; do
    log_file="$RUN_DIR/$test_id/output.log"
    if [[ -f "$log_file" ]]; then
      echo ""
      echo -e "${RED}═══ $test_id ═══${NC}"
      cat "$log_file"
    fi
  done
fi

# Check for setup requirements (tests that were skipped due to missing configuration)
SETUP_FILES=()
while IFS= read -r setup_file; do
  [[ -n "$setup_file" ]] && SETUP_FILES+=("$setup_file")
done <<< "$(find "$RUN_DIR" -name ".setup_required" 2>/dev/null)"

if [[ ${#SETUP_FILES[@]} -gt 0 ]]; then
  echo ""
  echo -e "${YELLOW}════════════════════════════════════════${NC}"
  echo -e "${YELLOW}Setup Required${NC}"
  echo -e "${YELLOW}════════════════════════════════════════${NC}"
  echo ""
  # Show first setup message (they should all be similar for OAuth tests)
  cat "${SETUP_FILES[0]}"
  echo ""
  echo -e "${YELLOW}Some tests were skipped. Run the commands above to enable them.${NC}"
fi

# Generate coverage report if enabled
if [[ "$COVERAGE" == "true" ]]; then
  echo ""
  echo -e "${BLUE}════════════════════════════════════════${NC}"
  echo -e "${BLUE}Coverage Report${NC}"
  echo -e "${BLUE}════════════════════════════════════════${NC}"
  echo ""

  COVERAGE_DIR="$PROJECT_ROOT/test/coverage/e2e"
  mkdir -p "$COVERAGE_DIR"

  cd "$PROJECT_ROOT"
  npx c8 report \
    --temp-directory="$RUN_DIR/v8-coverage" \
    --include="dist/**/*.js" \
    --exclude="node_modules/**" \
    --reporter=text \
    --reporter=lcov \
    --reporter=html \
    --reporter=json \
    --reports-dir="$COVERAGE_DIR" \
    2>/dev/null || {
      echo -e "${YELLOW}Warning: Could not generate coverage report${NC}"
      echo "Coverage data is in: $RUN_DIR/v8-coverage"
    }

  # Add custom title to HTML report
  find "$COVERAGE_DIR" -name "*.html" -exec sed -i '' \
    -e 's/Code coverage report for All files/mcpc Coverage (E2E Tests)/g' \
    -e 's/<h1>All files<\/h1>/<h1>E2E Test Coverage<\/h1>/g' \
    {} \; 2>/dev/null || true

  echo ""
  echo "Coverage report: $COVERAGE_DIR/index.html"
  echo "LCOV data:       $COVERAGE_DIR/lcov.info"
fi

# Clean up empty tmp directories (no value keeping them)
find "$RUN_DIR" -type d -name "tmp" -empty -delete 2>/dev/null || true

# Kill any remaining bridge processes for this test run
cleanup_bridges() {
  local home_dir="$1"
  local sessions_file="$home_dir/sessions.json"

  if [[ -f "$sessions_file" ]]; then
    # Close each session properly
    for session in $(jq -r '.sessions | keys[]' "$sessions_file" 2>/dev/null); do
      MCPC_HOME_DIR="$home_dir" "$PROJECT_ROOT/dist/cli/index.js" "$session" close 2>/dev/null || true
    done
  fi

  # Also kill any bridge processes that might have the home dir in their args
  # (in case sessions.json is already deleted or corrupted)
  if _is_windows; then
    taskkill //F //IM node.exe 2>/dev/null || true
  else
    pkill -f "mcpc-bridge.*$home_dir" 2>/dev/null || true
    pkill -f "mcpc/dist/bridge.*$home_dir" 2>/dev/null || true
  fi

  # Give processes a moment to terminate
  sleep 0.5
}

# Kill any remaining test server processes
cleanup_test_servers() {
  if _is_windows; then
    :
  else
    pkill -f "test/e2e/server/index.ts" 2>/dev/null || true
    pkill -f "test/e2e/server/index-v2.ts" 2>/dev/null || true
  fi
  sleep 0.2
}

# Cleanup or preserve run directory
if [[ "$KEEP_RUNS" != "true" && $FAILED -eq 0 ]]; then
  cleanup_bridges "$E2E_SHARED_HOME"
  cleanup_test_servers
  rm -rf "$RUN_DIR"
  rm -rf "$E2E_SHARED_HOME"
  echo ""
  echo -e "${DIM}Test run directory cleaned up${NC}"
else
  echo ""
  echo "Test run directory: $RUN_DIR"
  echo "Shared home: $E2E_SHARED_HOME"

  # Clean up old runs (keep last 10)
  cd "$E2E_RUNS_DIR"
  ls -1dt */ 2>/dev/null | tail -n +11 | xargs -r rm -rf
fi

# Exit with appropriate code
if [[ $FAILED -gt 0 ]]; then
  exit 1
fi

echo ""
echo -e "${GREEN}All tests passed!${NC}"
