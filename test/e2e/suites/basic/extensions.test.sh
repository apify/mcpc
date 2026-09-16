#!/bin/bash
# Test: how a server's MCP extension declarations are reported.
#
# Extensions are opt-in on both sides, and a server declares whatever it serves on its own
# terms. mcpc must name every extension it is offered — including ones it cannot use and
# ones it has never heard of — without offering commands it would only fail to run. Runs in
# both protocol eras: the declarations ride the 2026-07-28 discover result and the
# 2025-11-25 initialize result alike.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/extensions"

start_test_server WITH_OTHER_EXTENSIONS=true

SESSION=$(session_name "extensions")

test_case "setup: connect to a server declaring extensions mcpc does not implement"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

test_case "session overview names an extension mcpc does not support"
run_mcpc "$SESSION"
assert_success
assert_contains "$STDOUT" "MCP Apps (extension, not supported by mcpc)"
test_pass

test_case "session overview names a vendor extension by its identifier"
run_mcpc "$SESSION"
assert_success
assert_contains "$STDOUT" "com.example/widgets (unknown extension)"
test_pass

test_case "session overview offers no commands for either of them"
run_mcpc "$SESSION"
assert_success
assert_not_contains "$STDOUT" "skills-list"
assert_not_contains "$STDOUT" "resources-directory-read"
test_pass

test_case "--json reports the server's extensions verbatim"
run_mcpc --json "$SESSION"
assert_success
assert_json_eq "$STDOUT" '.capabilities.extensions["io.modelcontextprotocol/ui"].mimeTypes[0]' "text/html;profile=mcp-app"
assert_json "$STDOUT" '.capabilities.extensions | has("com.example/widgets")'
test_pass

test_case "cleanup: close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
