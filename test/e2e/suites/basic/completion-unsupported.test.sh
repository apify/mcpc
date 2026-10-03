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

test_done
