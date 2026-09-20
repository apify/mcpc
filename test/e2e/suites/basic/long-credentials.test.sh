#!/bin/bash
# Test: credentials too large for a single OS keychain entry (#409)
#
# Windows Credential Manager caps a credential blob at 2560 bytes, and the keyring
# crate stores passwords as UTF-16, so anything over 1280 characters is refused.
# Most OAuth tokens are bigger than that. mcpc stores such a value in several
# entries instead; this suite proves the value survives that round trip byte for
# byte, against whatever credential store the platform actually provides — the
# real Credential Manager on the Windows runners, the real Keychain on macOS.
#
# The server is told the exact token to expect, so a credential that comes back
# truncated, reordered or corrupted fails the connection with a 401 instead of
# passing unnoticed.

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/long-credentials" --isolated

# 3000 characters: well past the 1280 one entry holds, and past 2560 too, so the
# value needs several parts however the limit is counted.
LONG_TOKEN="$(printf 'tok-%.0s' $(seq 1 750))"
[[ ${#LONG_TOKEN} -eq 3000 ]] || test_fail "expected a 3000-char token, got ${#LONG_TOKEN}"

start_test_server REQUIRE_AUTH=true "EXPECTED_BEARER_TOKEN=$LONG_TOKEN"

# =============================================================================
# Test: a session authenticates with a header too long for one keychain entry
# =============================================================================

test_case "connect with a credential larger than one keychain entry"
SESSION=$(session_name "long-cred")

run_mcpc connect "$TEST_SERVER_URL" "$SESSION" --header "Authorization: Bearer $LONG_TOKEN"
assert_success
_SESSIONS_CREATED+=("$SESSION")

wait_for "$MCPC $SESSION ping >/dev/null 2>&1"

run_mcpc "$SESSION" ping
assert_success

# Which store actually held it. mcpc only writes credentials.json when the OS
# keychain is unavailable, so its absence means the value went through the real
# keychain — and on Windows, where the entry limit is what #409 is about, that
# is the whole point of this suite, so falling back there is itself a failure.
if [[ -f "$MCPC_HOME_DIR/credentials.json" ]]; then
  echo "# credential store: file fallback (this runner has no usable OS keychain)"
  if is_windows; then
    test_fail "fell back to file storage on Windows instead of Credential Manager"
  fi
else
  echo "# credential store: OS keychain"
fi
test_pass

# =============================================================================
# Test: the bridge reloads it from storage on restart
#
# `restart` re-reads the headers from the credential store in a fresh process,
# which is the path that actually exercises reassembling a split value.
# =============================================================================

test_case "credential still works after the bridge restarts"
run_mcpc "$SESSION" restart
assert_success

wait_for "$MCPC $SESSION ping >/dev/null 2>&1"

run_mcpc "$SESSION" tools-list
assert_success
test_pass

# =============================================================================
# Test: the exact-token check is real — a truncated credential is rejected
#
# Guards the suite itself: if the server accepted any bearer token, the tests
# above would pass even when storage mangles the value.
# =============================================================================

test_case "a truncated credential is rejected by the server"
SESSION_BAD=$(session_name "short-cred")

run_mcpc connect "$TEST_SERVER_URL" "$SESSION_BAD" \
  --header "Authorization: Bearer ${LONG_TOKEN:0:1280}"
assert_failure
_SESSIONS_CREATED+=("$SESSION_BAD")
test_pass

# =============================================================================
# Test: closing the session removes the credential and all of its parts
# =============================================================================

test_case "closing the session cleans up the stored credential"
run_mcpc "$SESSION" close
assert_success

# Whatever store was used, no part of the token may be left behind in the
# fallback file (the keychain itself has no listing API to assert against).
# Matching the whole token keeps the still-open truncated-token session, whose
# value is a prefix of this one, from looking like a leftover.
cred_file="$MCPC_HOME_DIR/credentials.json"
if [[ -f "$cred_file" ]] && grep -q "$LONG_TOKEN" "$cred_file"; then
  test_fail "credential parts left in $cred_file after close"
fi
test_pass

test_done
