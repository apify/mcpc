#!/bin/bash
# Test: `mcpc connect <config-file>` connects all servers from a config file,
# and re-running the same command reuses existing sessions instead of creating
# duplicates (e.g., should NOT produce @alpha-2, @bravo-2 on second run).

source "$(dirname "$0")/../../lib/framework.sh"
test_init "basic/connect-config-file" --isolated

# Start test server
start_test_server

# Create a config file with two server entries (both pointing to the test server)
CONFIG_FILE="$(to_native_path "$TEST_TMP/multi-server.json")"
cat > "$CONFIG_FILE" <<EOF
{
  "mcpServers": {
    "alpha": {
      "url": "$TEST_SERVER_URL",
      "headers": { "X-Test": "true" }
    },
    "bravo": {
      "url": "$TEST_SERVER_URL",
      "headers": { "X-Test": "true" }
    }
  }
}
EOF

# Track sessions for cleanup (auto-generated from entry names)
_SESSIONS_CREATED+=("@alpha" "@bravo")

# =============================================================================
# Test: First connect creates one session per entry with auto-generated names
# =============================================================================

test_case "first connect creates @alpha and @bravo from config entries"
run_mcpc connect "$CONFIG_FILE"
assert_success "first connect should succeed"
assert_contains "$STDOUT" "@alpha"
assert_contains "$STDOUT" "@bravo"
assert_contains "$STDOUT" "live"

# Verify both sessions exist with names derived from entry names
run_mcpc --json
assert_success
alpha_name=$(echo "$STDOUT" | jq -r '.sessions[] | select(.name == "@alpha") | .name')
bravo_name=$(echo "$STDOUT" | jq -r '.sessions[] | select(.name == "@bravo") | .name')
assert_eq "$alpha_name" "@alpha" "@alpha session should exist"
assert_eq "$bravo_name" "@bravo" "@bravo session should exist"

# Should be exactly 2 sessions
total=$(echo "$STDOUT" | jq '.sessions | length')
assert_eq "$total" "2" "should have exactly 2 sessions after first connect"
test_pass

# =============================================================================
# Test: Re-running connect on the same file reuses existing sessions
# =============================================================================

test_case "re-connect reports sessions as already active (no new creation)"
run_mcpc connect "$CONFIG_FILE"
assert_success "re-connect should succeed"
# Both sessions should be reported as already active
assert_contains "$STDOUT" "already active"
test_pass

# =============================================================================
# Test: No duplicate / suffixed sessions after re-connect
# =============================================================================

test_case "no @alpha-2 / @bravo-2 sessions exist after re-connect"
run_mcpc --json
assert_success

# Total session count must remain 2 (not 4)
total=$(echo "$STDOUT" | jq '.sessions | length')
assert_eq "$total" "2" "should still have exactly 2 sessions after re-connect (no duplicates)"

# Verify no suffixed variants like @alpha-2, @bravo-2 were created
suffixed=$(echo "$STDOUT" | jq -r '[.sessions[] | select(.name | test("^@(alpha|bravo)-[0-9]+$")) | .name] | join(",")')
assert_eq "$suffixed" "" "no suffixed session names should exist"

# Original sessions still present
alpha_name=$(echo "$STDOUT" | jq -r '.sessions[] | select(.name == "@alpha") | .name')
bravo_name=$(echo "$STDOUT" | jq -r '.sessions[] | select(.name == "@bravo") | .name')
assert_eq "$alpha_name" "@alpha" "@alpha should still exist"
assert_eq "$bravo_name" "@bravo" "@bravo should still exist"
test_pass

# =============================================================================
# Test: Reused sessions are still functional
# =============================================================================

test_case "reused sessions are still functional"
run_mcpc "@alpha" tools-list
assert_success "tools-list should work on reused @alpha session"
assert_contains "$STDOUT" "echo"

run_mcpc "@bravo" tools-list
assert_success "tools-list should work on reused @bravo session"
assert_contains "$STDOUT" "echo"
test_pass

test_done
