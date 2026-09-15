#!/bin/bash
# Test: skills commands on a 2025-era connection.
#
# The io.modelcontextprotocol/skills extension is specified against MCP 2026-07-28 and
# later. A legacy server may still declare it — the 2025-era test server does, with its
# skill files served as ordinary resources — and mcpc must refuse the skill commands with
# an explanation rather than speak a dialect no server promises to serve.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/skills-legacy"
require_server_protocol legacy

start_test_server WITH_SKILLS=true

SESSION=$(session_name "skills-legacy")

test_case "setup: connect to a 2025-era server declaring the skills extension"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

test_case "session overview does not offer the skills commands"
run_mcpc "$SESSION"
assert_success
assert_not_contains "$STDOUT" "mcpc $SESSION skills-list"
assert_not_contains "$STDOUT" "resources-directory-read"
test_pass

test_case "skills-list explains that the extension needs 2026-07-28"
run_xmcpc "$SESSION" skills-list
assert_failure
assert_contains "$STDERR" "2026-07-28"
test_pass

test_case "skills-get explains the same"
run_mcpc "$SESSION" skills-get git-workflow
assert_failure
assert_contains "$STDERR" "2026-07-28"
test_pass

test_case "the skill files are still readable as ordinary resources"
run_mcpc "$SESSION" resources-read "skill://git-workflow/SKILL.md" --raw
assert_success
assert_contains "$STDOUT" "# Git workflow"
test_pass

test_case "cleanup: close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

test_done
