#!/bin/bash
# Master E2E test runner
#
# Usage:
#   ./run.sh              # Run all test suites
#   ./run.sh basic        # Run specific suite
#   ./run.sh basic tools  # Run multiple suites
#
# Options:
#   -p, --parallel N   Run N suites in parallel (default: 4)
#   -v, --verbose      Show verbose output
#   -k, --keep         Keep test home directory after tests
#   -h, --help         Show help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Default options
PARALLEL=4
VERBOSE=false
KEEP_HOME=false
SUITES=()

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -p|--parallel)
      PARALLEL="$2"
      shift 2
      ;;
    -v|--verbose)
      VERBOSE=true
      shift
      ;;
    -k|--keep)
      KEEP_HOME=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [options] [suite...]"
      echo ""
      echo "Options:"
      echo "  -p, --parallel N   Run N suites in parallel (default: 4)"
      echo "  -v, --verbose      Show verbose output"
      echo "  -k, --keep         Keep test home directory after tests"
      echo "  -h, --help         Show help"
      echo ""
      echo "Suites:"
      for suite in "$SCRIPT_DIR"/*/; do
        suite_name=$(basename "$suite")
        if [[ "$suite_name" != "lib" && "$suite_name" != "server" ]]; then
          echo "  $suite_name"
        fi
      done
      exit 0
      ;;
    -*)
      echo "Unknown option: $1"
      exit 1
      ;;
    *)
      SUITES+=("$1")
      shift
      ;;
  esac
done

# If no suites specified, find all
if [[ ${#SUITES[@]} -eq 0 ]]; then
  for suite in "$SCRIPT_DIR"/*/; do
    suite_name=$(basename "$suite")
    if [[ "$suite_name" != "lib" && "$suite_name" != "server" ]]; then
      SUITES+=("$suite_name")
    fi
  done
fi

# Setup test home directory
export MCPC_HOME_DIR="$HOME/.mcpc-e2e-test"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}mcpc E2E tests${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "Test home: $MCPC_HOME_DIR"
echo "Parallel:  $PARALLEL"
echo "Suites:    ${SUITES[*]}"
echo ""

# Clean previous test state
if [[ -d "$MCPC_HOME_DIR" ]]; then
  echo "Cleaning previous test state..."
  rm -rf "$MCPC_HOME_DIR"
fi
mkdir -p "$MCPC_HOME_DIR"

# Build mcpc
echo "Building mcpc..."
cd "$PROJECT_ROOT"
npm run build >/dev/null 2>&1 || {
  echo -e "${RED}Build failed${NC}"
  exit 1
}
echo -e "${GREEN}Build complete${NC}"
echo ""

# Results tracking
RESULTS_DIR=$(mktemp -d)
TOTAL_PASSED=0
TOTAL_FAILED=0
FAILED_SUITES=()

# Function to run a single suite
run_suite() {
  local suite="$1"
  local suite_dir="$SCRIPT_DIR/$suite"
  local result_file="$RESULTS_DIR/$suite.result"

  if [[ ! -d "$suite_dir" ]]; then
    echo "1" > "$result_file"  # Failed
    echo "Suite not found: $suite" >> "$result_file.log"
    return
  fi

  local suite_runner="$suite_dir/run-suite.sh"
  local log_file="$result_file.log"

  echo "Running suite: $suite..."

  if [[ -f "$suite_runner" ]]; then
    # Suite has custom runner
    if bash "$suite_runner" > "$log_file" 2>&1; then
      echo "0" > "$result_file"
    else
      echo "1" > "$result_file"
    fi
  else
    # Run all .test.sh files in the suite
    local suite_failed=0
    for test_file in "$suite_dir"/*.test.sh; do
      if [[ -f "$test_file" ]]; then
        if ! bash "$test_file" >> "$log_file" 2>&1; then
          suite_failed=1
        fi
      fi
    done
    echo "$suite_failed" > "$result_file"
  fi
}

export -f run_suite
export SCRIPT_DIR RESULTS_DIR MCPC_HOME_DIR PROJECT_ROOT

# Run suites (in parallel if multiple)
if [[ ${#SUITES[@]} -eq 1 ]]; then
  # Single suite - run directly for better output
  run_suite "${SUITES[0]}"
else
  # Multiple suites - run in parallel
  printf '%s\n' "${SUITES[@]}" | xargs -P "$PARALLEL" -I {} bash -c 'run_suite "$@"' _ {}
fi

# Collect results
echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Results${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

for suite in "${SUITES[@]}"; do
  result_file="$RESULTS_DIR/$suite.result"
  log_file="$result_file.log"

  if [[ -f "$result_file" ]]; then
    result=$(cat "$result_file")
    if [[ "$result" == "0" ]]; then
      echo -e "${GREEN}✓${NC} $suite"
      ((TOTAL_PASSED++)) || true
    else
      echo -e "${RED}✗${NC} $suite"
      ((TOTAL_FAILED++)) || true
      FAILED_SUITES+=("$suite")

      # Show failure details
      if [[ -f "$log_file" && "$VERBOSE" == "true" ]]; then
        echo "  Log:"
        sed 's/^/    /' "$log_file"
      fi
    fi
  else
    echo -e "${YELLOW}?${NC} $suite (no result)"
  fi
done

# Summary
echo ""
echo -e "${BLUE}----------------------------------------${NC}"
echo "Total: $((TOTAL_PASSED + TOTAL_FAILED)) suites"
echo -e "Passed: ${GREEN}$TOTAL_PASSED${NC}"
echo -e "Failed: ${RED}$TOTAL_FAILED${NC}"

# Show failed suite logs if not verbose
if [[ ${#FAILED_SUITES[@]} -gt 0 && "$VERBOSE" != "true" ]]; then
  echo ""
  echo "Failed suite logs:"
  for suite in "${FAILED_SUITES[@]}"; do
    log_file="$RESULTS_DIR/$suite.result.log"
    if [[ -f "$log_file" ]]; then
      echo ""
      echo -e "${RED}=== $suite ===${NC}"
      cat "$log_file"
    fi
  done
fi

# Cleanup
rm -rf "$RESULTS_DIR"

if [[ "$KEEP_HOME" != "true" ]]; then
  rm -rf "$MCPC_HOME_DIR"
else
  echo ""
  echo "Test home preserved: $MCPC_HOME_DIR"
fi

# Exit with failure if any suite failed
if [[ $TOTAL_FAILED -gt 0 ]]; then
  exit 1
fi

echo ""
echo -e "${GREEN}All tests passed!${NC}"
