#!/bin/bash
# Test: mcpc's own MCP extension declarations, and how a server's are reported.
#
# Extensions are opt-in on both sides, and a server declares whatever it serves on its own
# terms. mcpc must name every extension it is offered — including ones it cannot use and
# ones it has never heard of — without offering commands it would only fail to run. Runs in
# both protocol eras: the declarations ride the 2026-07-28 discover result and the
# 2025-11-25 initialize result alike.
#
# mcpc's declarations go the other way: https://modelcontextprotocol.io/extensions/client-matrix
# has clients declare support in the `extensions` field of the client capabilities —
# `_meta["io.modelcontextprotocol/clientCapabilities"]` on every 2026-07-28 request, the
# `initialize` capabilities on 2025-11-25. Each extension defines its own settings object;
# the two auth extensions and the tasks extension define none, so each is declared as `{}`.

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

test_case "server receives mcpc's extension declarations on a regular request"
# A tools/call rather than the connect-time handshake: on 2026-07-28 the capabilities ride
# every request's _meta, and a server may only see this one. Tasks is among them: a server
# may only hand a task to a client that declared the extension on that very request.
run_mcpc "$SESSION" tools-call echo message:=hi
assert_success
CLIENT_CAPS=$(server_get_client_capabilities)
assert_json_eq "$CLIENT_CAPS" '.capabilities.extensions | keys | sort | join(",")' \
  "io.modelcontextprotocol/enterprise-managed-authorization,io.modelcontextprotocol/oauth-client-credentials,io.modelcontextprotocol/tasks"
assert_json_eq "$CLIENT_CAPS" '.capabilities.extensions["io.modelcontextprotocol/oauth-client-credentials"] | tojson' "{}"
assert_json_eq "$CLIENT_CAPS" '.capabilities.extensions["io.modelcontextprotocol/enterprise-managed-authorization"] | tojson' "{}"
assert_json_eq "$CLIENT_CAPS" '.capabilities.extensions["io.modelcontextprotocol/tasks"] | tojson' "{}"
test_pass

test_case "mcpc does not declare extensions it does not implement or that servers declare"
# MCP Apps has no terminal equivalent; skills is declared by servers only, so a client-side
# claim would be invented.
assert_json "$CLIENT_CAPS" '.capabilities.extensions | has("io.modelcontextprotocol/ui") | not'
assert_json "$CLIENT_CAPS" '.capabilities.extensions | has("io.modelcontextprotocol/skills") | not'
test_pass

test_case "cleanup: close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
