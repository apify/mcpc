# Testing

This directory contains the test suite for mcpc.

## Quick start

```bash
npm test                    # Run all tests (unit + e2e)
npm run test:unit           # Run unit tests only
npm run test:e2e            # Run e2e tests only
npm run test:coverage       # Run all tests with coverage and merge reports
npm run test:coverage:unit  # Run unit tests with coverage
npm run test:coverage:e2e   # Run e2e tests with coverage
```

## Unit tests

Unit tests use [Jest](https://jestjs.io/) with TypeScript and live in `test/unit/`. They test individual modules in isolation with mocked dependencies.

### Running unit tests

```bash
npm run test:unit           # Run once
npm run test:watch          # Watch mode - rerun on changes
npm run test:coverage:unit  # Generate coverage report
```

### Coverage

Coverage reports are generated to `test/coverage/unit/`:
- `test/coverage/unit/lcov-report/index.html` - HTML report (open in browser)
- `test/coverage/unit/lcov.info` - LCOV format (for CI integration)

Coverage thresholds are enforced at 70% for branches, functions, lines, and statements.

Unit test coverage measures the TypeScript source files directly via Jest's instrumentation.

### Writing unit tests

Create files in `test/unit/` matching the source structure with `.test.ts` extension:

```typescript
// test/unit/lib/utils.test.ts
import { someFunction } from '../../../src/lib/utils.js';

describe('someFunction', () => {
  it('should handle normal input', () => {
    expect(someFunction('input')).toBe('expected');
  });

  it('should throw on invalid input', () => {
    expect(() => someFunction(null)).toThrow('Invalid input');
  });
});
```

### Unit test structure

```
test/unit/
├── cli/                    # CLI module tests
│   ├── index.test.ts
│   ├── output.test.ts
│   ├── parser.test.ts
│   └── shell.test.ts
├── core/                   # Core module tests
│   ├── factory.test.ts
│   └── transports.test.ts
└── lib/                    # Library tests
    ├── config.test.ts
    ├── errors.test.ts
    ├── logger.test.ts
    └── utils.test.ts
```

## E2E tests

End-to-end tests verify mcpc behavior from the command line, testing real MCP connections with session management, bridge processes, and various transports.

### Running tests

```bash
# Run all tests (parallel by default)
./test/e2e/run.sh

# Run a specific test suite
./test/e2e/run.sh basic/
./test/e2e/run.sh sessions/

# Run a specific test
./test/e2e/run.sh basic/help.test.sh

# Options
./test/e2e/run.sh -p 1          # Run sequentially (parallel=1)
./test/e2e/run.sh -c            # Collect code coverage
./test/e2e/run.sh -v            # Verbose - show output as tests run
./test/e2e/run.sh -k            # Keep test run directory after tests
./test/e2e/run.sh -l            # List available tests
./test/e2e/run.sh -h            # Show help
```

### E2E coverage

E2E tests can also collect code coverage using Node.js V8 coverage:

```bash
npm run test:coverage:e2e       # Run E2E tests with coverage
./test/e2e/run.sh --coverage    # Same as above
```

Coverage reports are generated to `test/coverage/e2e/`:
- `test/coverage/e2e/index.html` - HTML report
- `test/coverage/e2e/lcov.info` - LCOV format

E2E coverage uses V8's built-in coverage (via `c8`), which traces the compiled JavaScript and maps back to TypeScript via source maps. This provides real coverage data from actual CLI usage, complementing unit test coverage.

## Combined coverage

To generate a merged coverage report from both unit and E2E tests:

```bash
# Run all tests with coverage and merge
npm run test:coverage

# Or run individually then merge
npm run test:coverage:unit      # Unit tests
npm run test:coverage:e2e       # E2E tests
npm run test:coverage:merge     # Merge reports
```

Merged coverage is saved to `test/coverage/merged/`:
- `test/coverage/merged/index.html` - Combined HTML report (nyc-style)
- `test/coverage/merged/lcov.info` - Combined LCOV data (for CI tools like Codecov)

### Test isolation

Each test runs in complete isolation:
- **Unique home directory**: Each test gets its own `MCPC_HOME_DIR` in `/tmp`
- **Unique session names**: Generated using `session_name "suffix"` to avoid conflicts
- **Automatic cleanup**: Sessions are closed and temp directories removed on exit
- **Parallel-safe**: Tests can run concurrently without interference

### Test invariants

The framework enforces these invariants via `run_xmcpc`:
- `--verbose` only adds to stderr, never changes stdout
- `--json` always returns valid JSON (on success and on error)

### Writing a new test

1. Create a file in the appropriate suite directory with `.test.sh` extension:

```bash
#!/bin/bash
# Test: Description of what this test covers

source "$(dirname "$0")/../../lib/framework.sh"
test_init "suite/test-name"

# Test case 1
test_case "description of what we're testing"
run_mcpc --help
assert_success
assert_contains "$STDOUT" "Usage:"
test_pass

# Test case 2 with session
test_case "create and use a session"
SESSION=$(session_name "mysession")
run_mcpc "$TEST_SERVER_URL" session "$SESSION"
assert_success
_SESSIONS_CREATED+=("$SESSION")  # Track for cleanup

run_mcpc "$SESSION" tools-list
assert_success
test_pass

test_done
```

2. Make it executable: `chmod +x test/e2e/suites/mysuite/mytest.test.sh`

3. Run it: `./test/e2e/run.sh mysuite/mytest.test.sh`

### Framework reference

#### Test structure

```bash
test_init "suite/test-name"  # Initialize test environment
test_case "description"       # Start a test case
test_pass                     # Mark current case as passed
test_fail "reason"            # Mark current case as failed
test_skip "reason"            # Skip current case
test_done                     # Print summary and exit
```

#### Running commands

```bash
run_mcpc <args>               # Run mcpc, sets $STDOUT, $STDERR, $EXIT_CODE
run_mcpc_json <args>          # Run mcpc --json <args>
run_xmcpc <args>              # Run with invariant checks (--verbose, --json)
```

#### Session helpers

```bash
SESSION=$(session_name "suffix")           # Generate unique session name
SESSION=$(create_session "$target" "suffix")  # Create session and track it
```

#### Assertions

```bash
assert_success                              # Exit code should be 0
assert_failure                              # Exit code should be non-zero
assert_exit_code 2                          # Exit code should be exactly 2
assert_contains "$STDOUT" "expected"        # String contains substring
assert_not_contains "$STDOUT" "unexpected"  # String doesn't contain substring
assert_eq "$actual" "$expected"             # Values are equal
assert_not_empty "$value"                   # Value is not empty
assert_empty "$value"                       # Value is empty
assert_json_valid "$STDOUT"                 # Valid JSON
assert_json "$STDOUT" '.field'              # JSON field exists/is truthy
assert_json_eq "$STDOUT" '.name' "expected" # JSON field equals value
assert_file_exists "$path"                  # File exists
assert_file_not_exists "$path"              # File doesn't exist
assert_stdout_empty                         # $STDOUT is empty
assert_stderr_empty                         # $STDERR is empty
```

#### Test server (for HTTP transport tests)

```bash
start_test_server                    # Start test MCP server, sets $TEST_SERVER_URL
start_test_server LATENCY_MS=100     # Start with custom env vars
stop_test_server                     # Stop test server (automatic on exit)

# Server control endpoints
server_fail_next 3                   # Make next 3 requests fail
server_expire_session                # Expire current session
server_reset                         # Reset server state
```

#### Stdio transport helpers

```bash
CONFIG=$(create_fs_config "$path")           # Create config for filesystem server
CONFIG=$(create_stdio_config "name" "cmd" "arg1" "arg2")  # Create custom stdio config
```

#### Utilities

```bash
json_get ".field.path"               # Extract field from $STDOUT
wait_for "command" 10                # Wait up to 10s for command to succeed
is_macos                             # Check if running on macOS
is_linux                             # Check if running on Linux
```

### Test directory structure

```
test/
├── e2e/
│   ├── run.sh              # Test runner
│   ├── lib/
│   │   └── framework.sh    # Testing framework
│   ├── server/
│   │   └── index.ts        # Test MCP server
│   └── suites/             # Test suites
│       ├── basic/          # Basic CLI tests
│       │   ├── help.test.sh
│       │   ├── errors.test.sh
│       │   └── output-invariants.test.sh
│       ├── sessions/       # Session management tests
│       │   ├── lifecycle.test.sh
│       │   └── failover.test.sh
│       └── stdio/          # Stdio transport tests
│           └── filesystem.test.sh
└── runs/                   # Test run artifacts (auto-cleaned)
```

### Environment variables

- `E2E_RUN_ID` - Unique ID for the test run (auto-generated)
- `E2E_RUNS_DIR` - Directory for test run artifacts
- `MCPC_HOME_DIR` - mcpc home directory (set per-test)
- `TEST_TMP` - Temp directory for test artifacts
- `TEST_SERVER_URL` - URL of test MCP server (when started)
- `TEST_SERVER_PORT` - Port for test server (0 = random)
