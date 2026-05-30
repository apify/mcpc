#!/bin/bash
# Test: Skills extension (SEP-2640, io.modelcontextprotocol/skills)
# Tests skills-list, skills-get, --raw mode, --json shapes, and the
# resource-scan fallback when skill://index.json is absent.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/skills"

# =============================================================================
# Scenario 1: server with skill://index.json (default)
# =============================================================================

start_test_server WITH_SKILLS=true

SESSION=$(session_name "skills")

test_case "setup: connect to server with skills extension"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

# -----------------------------------------------------------------------------
# Capability surfacing in session overview
# -----------------------------------------------------------------------------

test_case "session overview lists skills under capabilities"
run_mcpc "$SESSION"
assert_success
assert_contains "$STDOUT" "skills (experimental extension)"
test_pass

test_case "session overview lists skills-list/skills-get commands"
run_mcpc "$SESSION"
assert_success
assert_contains "$STDOUT" "skills-list"
assert_contains "$STDOUT" "skills-get"
test_pass

# -----------------------------------------------------------------------------
# skills-list (index path)
# -----------------------------------------------------------------------------

test_case "skills-list returns skills from index"
run_xmcpc "$SESSION" skills-list
assert_success
assert_not_empty "$STDOUT"
assert_contains "$STDOUT" "git-workflow"
assert_contains "$STDOUT" "refunds"
test_pass

test_case "skills-list human output shows count and descriptions"
run_mcpc "$SESSION" skills-list
assert_success
assert_contains "$STDOUT" "Skills (3):"
assert_contains "$STDOUT" "Helpers for everyday Git workflows"
assert_contains "$STDOUT" "How acme processes refund requests"
test_pass

test_case "skills-list human output includes a hint to skills-get"
run_mcpc "$SESSION" skills-list
assert_success
assert_contains "$STDOUT" "skills-get"
assert_contains "$STDOUT" "--raw"
test_pass

test_case "skills-list --json returns valid array of Skill objects"
run_mcpc --json "$SESSION" skills-list
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '. | type == "array"'
# 4 entries in the index, but the one with an unrecognized `type` is
# skipped per SEP-2640, leaving 3: 2 skill-md + 1 archive.
assert_json "$STDOUT" '. | length == 3'
# Each entry has the SEP-2640 fields
assert_json "$STDOUT" '.[0].name'
assert_json "$STDOUT" '.[0].description'
assert_json "$STDOUT" '.[0].url'
assert_json "$STDOUT" '.[0].type == "skill-md"'
# `archive` entries from the index are included (with type preserved)
assert_json "$STDOUT" '[.[] | .type] | any(. == "archive")'
# Unrecognized types are skipped — `future-thing` MUST NOT appear
assert_json "$STDOUT" '[.[] | .name] | any(. == "future-thing") | not'
test_pass

test_case "skills-list --json contains expected URIs"
run_mcpc --json "$SESSION" skills-list
assert_success
assert_json "$STDOUT" '[.[] | .url] | any(. == "skill://git-workflow/SKILL.md")'
assert_json "$STDOUT" '[.[] | .url] | any(. == "skill://acme/billing/refunds/SKILL.md")'
assert_json "$STDOUT" '[.[] | .url] | any(. == "skill://big-skill/big-skill.tar.gz")'
test_pass

# -----------------------------------------------------------------------------
# skills-get (bare name, nested path, full URI, --raw, --json)
# -----------------------------------------------------------------------------

test_case "skills-get by bare name reads SKILL.md"
run_xmcpc "$SESSION" skills-get git-workflow
assert_success
assert_contains "$STDOUT" "skill://git-workflow/SKILL.md"
assert_contains "$STDOUT" "name: git-workflow"
assert_contains "$STDOUT" "Git workflow"
test_pass

test_case "skills-get by nested path resolves to skill://<path>/SKILL.md"
run_xmcpc "$SESSION" skills-get acme/billing/refunds
assert_success
assert_contains "$STDOUT" "skill://acme/billing/refunds/SKILL.md"
assert_contains "$STDOUT" "Acme's refund flow"
test_pass

test_case "skills-get by full skill:// URI works"
run_mcpc "$SESSION" skills-get "skill://git-workflow/SKILL.md"
assert_success
assert_contains "$STDOUT" "name: git-workflow"
test_pass

test_case "skills-get --raw prints just the markdown body"
run_mcpc "$SESSION" skills-get git-workflow --raw
assert_success
# No mcpc-added headers / fences in --raw mode
assert_not_contains "$STDOUT" "Skill:"
assert_not_contains "$STDOUT" "MIME type:"
assert_not_contains "$STDOUT" '````'
# Markdown body is present
assert_contains "$STDOUT" "name: git-workflow"
assert_contains "$STDOUT" "# Git workflow"
test_pass

test_case "skills-get --json returns full ReadResourceResult"
run_mcpc --json "$SESSION" skills-get git-workflow
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '.contents | type == "array"'
assert_json "$STDOUT" '.contents[0].uri == "skill://git-workflow/SKILL.md"'
assert_json "$STDOUT" '.contents[0].mimeType == "text/markdown"'
assert_json "$STDOUT" '.contents[0].text | type == "string"'
test_pass

test_case "skills-get --json with --raw still emits full ReadResourceResult"
# --raw is a human-mode convenience; in --json mode the structured payload
# is what callers want, so --raw is ignored (documented in --help).
run_mcpc --json "$SESSION" skills-get git-workflow --raw
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '.contents[0].uri == "skill://git-workflow/SKILL.md"'
test_pass

test_case "skills-get unknown skill fails"
run_mcpc "$SESSION" skills-get does-not-exist
assert_failure
test_pass

# -----------------------------------------------------------------------------
# Cleanup scenario 1
# -----------------------------------------------------------------------------

test_case "cleanup: close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

stop_test_server

# =============================================================================
# Scenario 2: server WITHOUT skill://index.json — exercises the fallback path
# of scanning the resource list for skill://*/SKILL.md URIs.
# =============================================================================

# Reset server state and start with a different config
TEST_SERVER_PORT=0
start_test_server WITH_SKILLS=true SKILLS_NO_INDEX=true

SESSION_FB=$(session_name "skills-fb")

test_case "setup: connect to server with skills (no index, fallback only)"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION_FB" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION_FB")
test_pass

test_case "fallback: skills-list still finds skills via resource scan"
run_mcpc "$SESSION_FB" skills-list
assert_success
assert_contains "$STDOUT" "Skills"
assert_contains "$STDOUT" "git-workflow"
# The nested skill is named by its final path segment per SEP-2640
assert_contains "$STDOUT" "refunds"
test_pass

test_case "fallback: skills-list --json shape matches index path"
run_mcpc --json "$SESSION_FB" skills-list
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '. | type == "array"'
assert_json "$STDOUT" '. | length == 2'
# Fallback path always tags entries as "skill-md"
assert_json "$STDOUT" 'all(.[]; .type == "skill-md")'
# Non-SKILL.md files under skill:// are NOT promoted to skills
assert_json "$STDOUT" '[.[] | .url] | any(. | test("notes\\.md")) | not'
test_pass

test_case "fallback: skills-get still works when there is no index"
run_mcpc "$SESSION_FB" skills-get git-workflow --raw
assert_success
assert_contains "$STDOUT" "# Git workflow"
test_pass

test_case "cleanup: close fallback session"
run_mcpc "$SESSION_FB" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION_FB}")
test_pass

stop_test_server

# =============================================================================
# Scenario 3: server with skills disabled entirely
# =============================================================================

TEST_SERVER_PORT=0
# WITH_SKILLS is false by default, so this is a server with no skills extension
start_test_server

SESSION_NO=$(session_name "skills-no")

test_case "setup: connect to server without skills"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION_NO" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION_NO")
test_pass

test_case "session overview does NOT advertise skills"
run_mcpc "$SESSION_NO"
assert_success
assert_not_contains "$STDOUT" "skills (experimental extension)"
assert_not_contains "$STDOUT" "skills-list"
test_pass

test_case "skills-list returns helpful empty message"
run_mcpc "$SESSION_NO" skills-list
assert_success
# Human-readable hint about absent index + fallback
assert_contains "$STDOUT" "no skills"
test_pass

test_case "skills-list --json returns empty array"
run_mcpc --json "$SESSION_NO" skills-list
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '. == []'
test_pass

test_case "cleanup: close session"
run_mcpc "$SESSION_NO" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION_NO}")
test_pass

test_done
