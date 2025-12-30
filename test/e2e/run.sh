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
#   -p, --parallel N   Max parallel tests (default: 8)
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
PARALLEL=8
ISOLATED_ALL=false
COVERAGE=false
KEEP_RUNS=false
VERBOSE=false
LIST_ONLY=false
PATTERNS=()

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
DIM='\033[0;2m'
NC='\033[0m'

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
    -h|--help)
      echo "Usage: $0 [options] [pattern...]"
      echo ""
      echo "Options:"
      echo "  -p, --parallel N   Max parallel tests (default: 8)"
      echo "  -i, --isolated     Force all tests to use isolated home directories"
      echo "  -c, --coverage     Collect code coverage"
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

# Find all test files matching patterns
find_tests() {
  local tests=()

  if [[ ${#PATTERNS[@]} -eq 0 ]]; then
    # No pattern - find all tests in suites/
    while IFS= read -r -d '' test; do
      tests+=("$test")
    done < <(find "$SUITES_DIR" -name "*.test.sh" -print0 | sort -z)
  else
    for pattern in "${PATTERNS[@]}"; do
      if [[ -f "$SUITES_DIR/$pattern" ]]; then
        # Specific file
        tests+=("$SUITES_DIR/$pattern")
      elif [[ -d "$SUITES_DIR/$pattern" ]]; then
        # Directory - find all tests in it
        while IFS= read -r -d '' test; do
          tests+=("$test")
        done < <(find "$SUITES_DIR/$pattern" -name "*.test.sh" -print0 | sort -z)
      elif [[ -d "$SUITES_DIR/${pattern%/}" ]]; then
        # Directory without trailing slash
        while IFS= read -r -d '' test; do
          tests+=("$test")
        done < <(find "$SUITES_DIR/${pattern%/}" -name "*.test.sh" -print0 | sort -z)
      else
        echo "Warning: No tests match pattern: $pattern" >&2
      fi
    done
  fi

  printf '%s\n' "${tests[@]}"
}

# Get test name from path (relative to suites dir, without .test.sh)
test_name() {
  local path="$1"
  local rel="${path#$SUITES_DIR/}"
  echo "${rel%.test.sh}"
}

# Collect tests (compatible with bash 3.x on macOS)
TESTS=()
while IFS= read -r test; do
  [[ -n "$test" ]] && TESTS+=("$test")
done < <(find_tests)

if [[ ${#TESTS[@]} -eq 0 ]]; then
  echo "No tests found" >&2
  exit 1
fi

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

# Shared home directory is inside the run directory
E2E_SHARED_HOME="$RUN_DIR/_shared_home"
mkdir -p "$E2E_SHARED_HOME"
export E2E_SHARED_HOME

# Set up coverage collection if enabled
if [[ "$COVERAGE" == "true" ]]; then
  export NODE_V8_COVERAGE="$RUN_DIR/v8-coverage"
  mkdir -p "$NODE_V8_COVERAGE"
fi

# Build mcpc first
echo -e "${DIM}Building mcpc...${NC}"
cd "$PROJECT_ROOT"
if ! npm run build >/dev/null 2>&1; then
  echo -e "${RED}Build failed${NC}" >&2
  npm run build
  exit 1
fi
echo -e "${GREEN}Build complete${NC}"
echo ""

# Function to run a single test
run_test() {
  local test_path="$1"
  local test_id=$(test_name "$test_path")
  local test_dir="$E2E_RUNS_DIR/$E2E_RUN_ID/$test_id"

  # Ensure test directory exists (framework.sh creates it, but be safe)
  mkdir -p "$test_dir"

  # Run the test, output goes to test's directory
  if bash "$test_path" > "$test_dir/output.log" 2>&1; then
    echo "0" > "$test_dir/result"
  else
    echo "$?" > "$test_dir/result"
  fi
}

export -f run_test test_name
export SCRIPT_DIR SUITES_DIR E2E_RUN_ID E2E_RUNS_DIR E2E_SHARED_HOME E2E_ISOLATED_ALL PROJECT_ROOT NODE_V8_COVERAGE

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
    # Run test, show output in real-time, and save to file
    if bash "$test" 2>&1 | tee "$test_dir/output.log"; then
      echo "0" > "$test_dir/result"
      echo -e "${GREEN}✓${NC} $name"
    else
      echo "${PIPESTATUS[0]}" > "$test_dir/result"
      echo -e "${RED}✗${NC} $name"
    fi
  done
else
  # Parallel execution
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
FAILED_TESTS=()

for test in "${TESTS[@]}"; do
  test_id=$(test_name "$test")
  test_dir="$RUN_DIR/$test_id"
  result_file="$test_dir/result"

  if [[ -f "$result_file" ]]; then
    result=$(cat "$result_file")
    if [[ "$result" == "0" ]]; then
      echo -e "${GREEN}✓${NC} $test_id"
      ((PASSED++)) || true
    else
      echo -e "${RED}✗${NC} $test_id (exit code: $result)"
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
echo "Total:  $((PASSED + FAILED))"
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"

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

# Cleanup or preserve run directory
if [[ "$KEEP_RUNS" != "true" && $FAILED -eq 0 ]]; then
  rm -rf "$RUN_DIR"
  echo ""
  echo -e "${DIM}Test run directory cleaned up${NC}"
else
  echo ""
  echo "Test run directory: $RUN_DIR"

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
