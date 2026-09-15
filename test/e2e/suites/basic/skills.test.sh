#!/bin/bash
# Test: Skills extension (io.modelcontextprotocol/skills)
# Covers skills-list, skills-get (SKILL.md and supporting files), the
# manifest/frontmatter verification that gates what gets printed, and
# resources-directory-read.
#
# The extension is specified against MCP 2026-07-28 and later, so this suite runs
# against the modern test server only; skills-legacy.test.sh covers the refusal on a
# 2025-era connection.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/skills"
require_server_protocol modern

# =============================================================================
# Scenario 1: server serving skills
# =============================================================================

start_test_server WITH_SKILLS=true

SESSION=$(session_name "skills")

test_case "setup: connect to server with the skills extension"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION")
test_pass

# -----------------------------------------------------------------------------
# Capability surfacing in session overview
# -----------------------------------------------------------------------------

test_case "session overview lists skills, with directory reads, under capabilities"
run_mcpc "$SESSION"
assert_success
assert_contains "$STDOUT" "skills (with directory reads)"
test_pass

test_case "session overview lists the skills commands"
run_mcpc "$SESSION"
assert_success
assert_contains "$STDOUT" "skills-list"
assert_contains "$STDOUT" "skills-get"
assert_contains "$STDOUT" "resources-directory-read"
test_pass

# -----------------------------------------------------------------------------
# skills-list
# -----------------------------------------------------------------------------

test_case "skills-list returns every skill the server serves"
run_xmcpc "$SESSION" skills-list
assert_success
assert_contains "$STDOUT" "Skills (3):"
assert_contains "$STDOUT" "git-workflow"
assert_contains "$STDOUT" "refunds"
assert_contains "$STDOUT" "daily"
test_pass

test_case "skills-list shows descriptions, URIs and manifest summaries"
run_mcpc "$SESSION" skills-list
assert_success
assert_contains "$STDOUT" "Helpers for everyday Git workflows"
assert_contains "$STDOUT" "skill://acme/billing/refunds/SKILL.md"
assert_contains "$STDOUT" "4 files"
# The generated skill publishes no digests, and says so rather than looking verified
assert_contains "$STDOUT" "dynamic, no digests published"
test_pass

test_case "skills-list human output includes a hint to skills-get"
run_mcpc "$SESSION" skills-list
assert_success
assert_contains "$STDOUT" "skills-get"
assert_contains "$STDOUT" "--raw"
test_pass

test_case "skills-list --json returns spec-shaped Skill entries"
run_mcpc --json "$SESSION" skills-list
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '. | type == "array"'
assert_json "$STDOUT" '. | length == 3'
assert_json "$STDOUT" '[.[] | .uri] | any(. == "skill://git-workflow/SKILL.md")'
assert_json "$STDOUT" '[.[] | .uri] | any(. == "skill://acme/billing/refunds/SKILL.md")'
assert_json "$STDOUT" '[.[] | .frontmatter.name] | any(. == "refunds")'
test_pass

test_case "skills-list --json carries the complete file manifest"
run_mcpc --json "$SESSION" skills-list
assert_success
# Every file of the refunds skill, SKILL.md included, with digest and size
assert_json "$STDOUT" '[.[] | select(.uri | test("refunds"))][0].resources | length == 4'
assert_json "$STDOUT" \
  '[.[] | select(.uri | test("refunds"))][0].resources | all(.digest | test("^sha256:[0-9a-f]{64}$"))'
assert_json "$STDOUT" \
  '[.[] | select(.uri | test("refunds"))][0].resources | all(.size | type == "number")'
# A generated skill carries the string "dynamic" instead
assert_json "$STDOUT" '[.[] | select(.frontmatter.name == "daily")][0].resources == "dynamic"'
test_pass

test_case "skills-list --json passes frontmatter through verbatim"
run_mcpc --json "$SESSION" skills-list
assert_success
assert_json "$STDOUT" '[.[] | select(.frontmatter.name == "refunds")][0].frontmatter.license == "Apache-2.0"'
assert_json "$STDOUT" \
  '[.[] | select(.frontmatter.name == "refunds")][0].frontmatter.metadata.version == "2.1.0"'
test_pass

# -----------------------------------------------------------------------------
# skills-get
# -----------------------------------------------------------------------------

test_case "skills-get by bare name reads the verified SKILL.md"
run_xmcpc "$SESSION" skills-get git-workflow
assert_success
assert_contains "$STDOUT" "skill://git-workflow/SKILL.md"
assert_contains "$STDOUT" "verified against the skill manifest"
assert_contains "$STDOUT" "# Git workflow"
test_pass

test_case "skills-get resolves a nested skill by name"
run_xmcpc "$SESSION" skills-get refunds
assert_success
assert_contains "$STDOUT" "skill://acme/billing/refunds/SKILL.md"
assert_contains "$STDOUT" "# Refunds"
test_pass

test_case "skills-get resolves a nested skill by path"
run_mcpc "$SESSION" skills-get acme/billing/refunds
assert_success
assert_contains "$STDOUT" "skill://acme/billing/refunds/SKILL.md"
test_pass

test_case "skills-get accepts the SKILL.md URI"
run_mcpc "$SESSION" skills-get "skill://git-workflow/SKILL.md"
assert_success
assert_contains "$STDOUT" "# Git workflow"
test_pass

test_case "skills-get lists the skill's supporting files from the manifest"
run_mcpc "$SESSION" skills-get refunds
assert_success
assert_contains "$STDOUT" "Supporting files (3):"
assert_contains "$STDOUT" "examples/email.md"
assert_contains "$STDOUT" "templates/regional/eu-invoice.md"
test_pass

test_case "skills-get reads a supporting file, verified against the manifest"
run_xmcpc "$SESSION" skills-get refunds examples/email.md
assert_success
assert_contains "$STDOUT" "Skill file:"
assert_contains "$STDOUT" "examples/email.md"
assert_contains "$STDOUT" "Dear customer"
test_pass

test_case "skills-get refuses a file the manifest does not list"
run_mcpc "$SESSION" skills-get refunds examples/not-a-real-file.md
assert_failure
test_pass

test_case "skills-get refuses a path escaping the skill directory"
run_mcpc "$SESSION" skills-get refunds ../git-workflow/SKILL.md
assert_failure
assert_contains "$STDERR" "escapes the skill directory"
test_pass

test_case "skills-get --raw prints just the file content"
run_mcpc "$SESSION" skills-get git-workflow --raw
assert_success
assert_not_contains "$STDOUT" "Skill:"
assert_not_contains "$STDOUT" '````'
assert_contains "$STDOUT" "name: git-workflow"
assert_contains "$STDOUT" "# Git workflow"
test_pass

test_case "skills-get --json returns the entry alongside the content"
run_mcpc --json "$SESSION" skills-get git-workflow
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '.skill.uri == "skill://git-workflow/SKILL.md"'
assert_json "$STDOUT" '.skill.frontmatter.name == "git-workflow"'
assert_json "$STDOUT" '.skill.resources | length == 1'
assert_json "$STDOUT" '.contents[0].uri == "skill://git-workflow/SKILL.md"'
assert_json "$STDOUT" '.contents[0].mimeType == "text/markdown"'
assert_json "$STDOUT" '.contents[0].text | type == "string"'
test_pass

test_case "skills-get --json with --raw still emits the structured payload"
# --raw is a human-mode convenience; in --json mode the structured payload
# is what callers want, so --raw is ignored (documented in --help).
run_mcpc --json "$SESSION" skills-get git-workflow --raw
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '.skill.uri == "skill://git-workflow/SKILL.md"'
test_pass

test_case "skills-get reads a dynamic skill but calls it unverified"
run_mcpc "$SESSION" skills-get daily
assert_success
assert_contains "$STDOUT" "dynamic skill"
assert_contains "$STDOUT" "unverified"
assert_contains "$STDOUT" "# Daily report"
test_pass

test_case "skills-get of an unknown skill fails"
run_mcpc "$SESSION" skills-get does-not-exist
assert_failure
test_pass

# -----------------------------------------------------------------------------
# resources-directory-read
# -----------------------------------------------------------------------------

test_case "resources-directory-read lists a skill directory's children"
run_xmcpc "$SESSION" resources-directory-read "skill://acme/billing/refunds"
assert_success
assert_contains "$STDOUT" "SKILL.md"
assert_contains "$STDOUT" "examples"
assert_contains "$STDOUT" "templates"
test_pass

test_case "resources-directory-read lists one level and marks subdirectories"
run_mcpc --json "$SESSION" resources-directory-read "skill://acme/billing/refunds/templates"
assert_success
assert_json_valid "$STDOUT"
assert_json "$STDOUT" '. | length == 2'
assert_json "$STDOUT" \
  '[.[] | select(.mimeType == "inode/directory")][0].uri == "skill://acme/billing/refunds/templates/regional"'
# Not recursive: the nested file is not in this result
assert_json "$STDOUT" '[.[] | .uri] | any(. | test("eu-invoice")) | not'
test_pass

test_case "resources-directory-read descends into a child directory"
run_mcpc "$SESSION" resources-directory-read "skill://acme/billing/refunds/templates/regional"
assert_success
assert_contains "$STDOUT" "eu-invoice.md"
test_pass

test_case "resources-directory-read fails on a URI that is not a directory"
run_mcpc "$SESSION" resources-directory-read "skill://git-workflow/SKILL.md"
assert_failure
test_pass

test_case "cleanup: close session"
run_mcpc "$SESSION" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION}")
test_pass

stop_test_server

# =============================================================================
# Scenario 2: a server that paginates its listing
# =============================================================================

TEST_SERVER_PORT=0
start_test_server WITH_SKILLS=true PAGINATION_SIZE=1

SESSION_PAGE=$(session_name "skills-page")

test_case "setup: connect to the paginating server"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION_PAGE" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION_PAGE")
test_pass

test_case "skills-list follows nextCursor through every page"
run_xmcpc --json "$SESSION_PAGE" skills-list
assert_success
assert_json "$STDOUT" '. | length == 3'
assert_json "$STDOUT" '[.[] | .frontmatter.name] | any(. == "daily")'
test_pass

test_case "resources-directory-read follows nextCursor too"
run_mcpc --json "$SESSION_PAGE" resources-directory-read "skill://acme/billing/refunds"
assert_success
assert_json "$STDOUT" '. | length == 3'
test_pass

test_case "cleanup: close paginating session"
run_mcpc "$SESSION_PAGE" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION_PAGE}")
test_pass

stop_test_server

# =============================================================================
# Scenario 3: a server that contradicts its own manifest
# =============================================================================

TEST_SERVER_PORT=0
start_test_server WITH_SKILLS=true SKILLS_TAMPER=content

SESSION_BAD=$(session_name "skills-bad")

test_case "setup: connect to the tampering server"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION_BAD" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION_BAD")
test_pass

test_case "skills-get refuses content whose digest does not match the manifest"
run_mcpc "$SESSION_BAD" skills-get git-workflow
assert_failure
assert_contains "$STDERR" "digest"
# The unverified content must not be printed
assert_not_contains "$STDOUT" "Then wipe"
test_pass

test_case "skills-get --raw refuses it too, printing nothing"
run_mcpc "$SESSION_BAD" skills-get git-workflow --raw
assert_failure
assert_not_contains "$STDOUT" "Then wipe"
test_pass

test_case "a skill the server does not tamper with still reads"
run_mcpc "$SESSION_BAD" skills-get refunds
assert_success
assert_contains "$STDOUT" "# Refunds"
test_pass

test_case "cleanup: close tampering session"
run_mcpc "$SESSION_BAD" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION_BAD}")
test_pass

stop_test_server

# =============================================================================
# Scenario 3b: a server whose content is a different length than the manifest says
# =============================================================================

TEST_SERVER_PORT=0
start_test_server WITH_SKILLS=true SKILLS_TAMPER=size

SESSION_SIZE=$(session_name "skills-size")

test_case "setup: connect to the size-mismatch server"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION_SIZE" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION_SIZE")
test_pass

test_case "skills-get refuses content whose byte length the manifest does not match"
run_mcpc "$SESSION_SIZE" skills-get git-workflow
assert_failure
assert_contains "$STDERR" "bytes"
assert_not_contains "$STDOUT" "rm -rf"
test_pass

test_case "cleanup: close size-mismatch session"
run_mcpc "$SESSION_SIZE" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION_SIZE}")
test_pass

stop_test_server

# =============================================================================
# Scenario 4: an entry advertising frontmatter the SKILL.md does not carry
# =============================================================================

TEST_SERVER_PORT=0
start_test_server WITH_SKILLS=true SKILLS_TAMPER=frontmatter

SESSION_FM=$(session_name "skills-fm")

test_case "setup: connect to the frontmatter-mismatch server"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION_FM" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION_FM")
test_pass

test_case "skills-get refuses a SKILL.md that is not what its entry describes"
run_mcpc "$SESSION_FM" skills-get refunds
assert_failure
assert_contains "$STDERR" "Frontmatter"
assert_contains "$STDERR" "description"
assert_not_contains "$STDOUT" "# Refunds"
test_pass

test_case "cleanup: close frontmatter session"
run_mcpc "$SESSION_FM" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION_FM}")
test_pass

stop_test_server

# =============================================================================
# Scenario 5: a server that does not declare the extension
# =============================================================================

TEST_SERVER_PORT=0
# WITH_SKILLS is false by default, so this server declares no skills extension
start_test_server

SESSION_NO=$(session_name "skills-no")

test_case "setup: connect to a server without skills"
run_mcpc connect "$TEST_SERVER_URL" "$SESSION_NO" --header "X-Test: true"
assert_success
_SESSIONS_CREATED+=("$SESSION_NO")
test_pass

test_case "session overview does not advertise skills"
run_mcpc "$SESSION_NO"
assert_success
assert_not_contains "$STDOUT" "skills-list"
assert_not_contains "$STDOUT" "resources-directory-read"
test_pass

test_case "skills-list says the server declares no skills extension"
run_mcpc "$SESSION_NO" skills-list
assert_failure
assert_contains "$STDERR" "io.modelcontextprotocol/skills"
assert_contains "$STDERR" "resources-list"
test_pass

test_case "resources-directory-read is refused without the directoryRead setting"
run_mcpc "$SESSION_NO" resources-directory-read "skill://whatever"
assert_failure
test_pass

test_case "cleanup: close session"
run_mcpc "$SESSION_NO" close
assert_success
_SESSIONS_CREATED=("${_SESSIONS_CREATED[@]/$SESSION_NO}")
test_pass

test_done
