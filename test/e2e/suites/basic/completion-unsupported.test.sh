#!/bin/bash
# Test: completion-complete against a server without the completions capability.
#
# The spec requires servers to declare `completions` before answering
# `completion/complete`, so mcpc refuses up front with an explanation instead of
# sending a request the server would reject with "method not found".

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/completion-unsupported"

start_test_server NO_COMPLETIONS=true

SESSION=$(session_name "nocmpl")

test_case "setup: connect to a server that declares no completions"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

test_case "session overview does not offer the command"
run_mcpc "$SESSION"
assert_success
assert_not_contains "$STDOUT" "completion-complete"
test_pass

test_case "completion-complete explains that the server declares no completions"
run_xmcpc "$SESSION" completion-complete prompt greeting style:=
assert_exit_code 2
assert_contains "$STDERR" "does not declare the completions capability"
assert_contains "$STDERR" "mcpc @session"
test_pass

test_case "cleanup: close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

# =============================================================================
# Through --proxy: the proxy advertises only what upstream can serve
# =============================================================================

UPSTREAM=$(session_name "nocmpl-up")
DOWNSTREAM=$(session_name "nocmpl-via")
PROXY_PORT=$((8300 + RANDOM % 100))

test_case "setup: expose the server through --proxy and connect to the proxy"
run_mcpc connect "$TEST_SERVER_URL" "$UPSTREAM" --header "X-Test: true" --proxy "$PROXY_PORT"
assert_success
_SESSIONS_CREATED+=("$UPSTREAM")
wait_for "curl -s http://127.0.0.1:$PROXY_PORT/health 2>/dev/null | grep -q ok"
run_mcpc connect "127.0.0.1:$PROXY_PORT" "$DOWNSTREAM"
assert_success
_SESSIONS_CREATED+=("$DOWNSTREAM")
test_pass

test_case "the proxy does not advertise completions its upstream lacks"
run_mcpc "$DOWNSTREAM"
assert_success
assert_not_contains "$STDOUT" "completions"
assert_not_contains "$STDOUT" "completion-complete"
run_xmcpc "$DOWNSTREAM" completion-complete prompt greeting style:=
assert_exit_code 2
assert_contains "$STDERR" "does not declare the completions capability"
test_pass

test_case "cleanup: close the proxy sessions"
run_mcpc "$DOWNSTREAM" close
assert_success
run_mcpc "$UPSTREAM" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$DOWNSTREAM}")
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$UPSTREAM}")
test_pass

test_done
