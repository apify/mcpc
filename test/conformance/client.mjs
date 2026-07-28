#!/usr/bin/env node

// Adapter that drives the mcpc CLI from the
// `@modelcontextprotocol/conformance` framework.
//
// The framework invokes this script with the test server URL appended as the
// last positional argument and sets `MCP_CONFORMANCE_SCENARIO` (plus an
// optional `MCP_CONFORMANCE_CONTEXT` JSON blob) in the environment.  Per
// scenario, we translate the expected behaviour into one or more mcpc
// sub-commands against a freshly-created session, then tear the session down
// again.
//
// Beyond the scenario-specific commands that the conformance server needs to
// observe, each scenario also runs a broader set of mcpc sub-commands
// (tools-list, tools-get, tools-call with/without --task, ping,
// logging-set-level, resources-list, prompts-list, ...) against the same
// server so the job exercises as much of mcpc's protocol surface as
// possible.  Commands that the test server does not implement are attempted
// as best-effort and their failures are swallowed so a missing capability on
// the server side does not mask real client-side issues.
//
// The `auth/*` scenarios additionally hand the adapter throwaway credentials
// in `MCP_CONFORMANCE_CONTEXT` and stand up their own authorization server,
// so the checks they record are about mcpc's OAuth behaviour rather than its
// MCP request encoding.
//
// Unsupported scenarios exit non-zero so the framework records them as
// failures.  The scenarios the adapter does not implement yet are listed in
// `test/conformance/README.md`.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const scenario = process.env.MCP_CONFORMANCE_SCENARIO;
const serverUrl = process.argv[process.argv.length - 1];

// Scenario-supplied data (credentials, keys, ...).  Absent for scenarios that
// need no client-side setup, so an unparseable or missing value is not fatal
// here — the individual cases validate the fields they actually need.
const context = (() => {
    const raw = process.env.MCP_CONFORMANCE_CONTEXT;
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch {
        console.error('[mcpc-conformance] ignoring unparseable MCP_CONFORMANCE_CONTEXT');
        return {};
    }
})();

if (!scenario) {
    console.error('MCP_CONFORMANCE_SCENARIO environment variable is not set');
    process.exit(1);
}
if (!serverUrl || !/^https?:\/\//i.test(serverUrl)) {
    console.error(`Missing or invalid server URL (got: ${serverUrl ?? ''})`);
    process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const mcpcBin = resolve(here, '..', '..', 'bin', 'mcpc');
const homeDir = await mkdtemp(`${tmpdir()}/mcpc-conformance-`);
const sessionName = `conformance-${process.pid}`;
const sessionArg = `@${sessionName}`;
const env = { ...process.env, MCPC_HOME_DIR: homeDir, MCPC_JSON: '1' };

function runMcpc(args, { timeoutMs, allowTimeout = false, expectExitCode = 0 } = {}) {
    return new Promise((res, rej) => {
        const child = spawn(mcpcBin, args, { env, stdio: 'inherit' });
        let timedOut = false;
        const timer = timeoutMs
            ? setTimeout(() => {
                  timedOut = true;
                  console.error(
                      `[mcpc-conformance] local timeout (${timeoutMs}ms) hit, terminating: mcpc ${args.join(' ')}`
                  );
                  child.kill('SIGTERM');
              }, timeoutMs)
            : null;
        child.once('error', (err) => {
            if (timer) clearTimeout(timer);
            rej(err);
        });
        child.once('exit', (code) => {
            if (timer) clearTimeout(timer);
            if (timedOut && allowTimeout) res();
            else if (code === expectExitCode) res();
            else if (expectExitCode === 0)
                rej(new Error(`mcpc ${args.join(' ')} exited with code ${code}`));
            else
                rej(
                    new Error(
                        `mcpc ${args.join(' ')} exited with code ${code}, expected ${expectExitCode}`
                    )
                );
        });
    });
}

// Best-effort wrapper: logs but swallows errors so an unsupported capability
// on the conformance test server does not fail the whole scenario.
async function tryMcpc(args) {
    try {
        await runMcpc(args);
    } catch (err) {
        console.error(
            `[mcpc-conformance] optional command failed (ignored): ${args.join(' ')} — ${
                err instanceof Error ? err.message : String(err)
            }`
        );
    }
}

// Reads a field the scenario is contractually required to provide, so a
// framework-side change surfaces as a clear adapter error rather than mcpc
// being blamed for a malformed command line.
function requireContext(field) {
    const value = context[field];
    if (typeof value !== 'string' || value === '') {
        throw new Error(
            `Scenario ${scenario} did not provide "${field}" in MCP_CONFORMANCE_CONTEXT`
        );
    }
    return value;
}

// Shared driver for the client-credentials scenarios (SEP-1046).  The
// scenario's authorization server records its checks during the token
// request, which `login` performs exactly once and up front; connecting
// afterwards proves the stored profile really authenticates an MCP session
// rather than just having survived the token exchange.
async function runClientCredentialsLogin(loginFlags) {
    await runMcpc(['login', serverUrl, '--grant', 'client-credentials', ...loginFlags]);
    await runMcpc(['connect', serverUrl, sessionArg]);
    await runMcpc([sessionArg, 'tools-list']);
    await runMcpc([sessionArg, 'ping']);
}

async function cleanup() {
    try {
        await runMcpc([sessionArg, 'close']);
    } catch {
        // Best effort — the session may never have been created.
    }
    await rm(homeDir, { recursive: true, force: true }).catch(() => {});
}

async function main() {
    switch (scenario) {
        case 'initialize':
            // The initialize test server only implements `initialize` and
            // `tools/list`; every other request is answered with an empty
            // result.  We exercise commands whose empty result still
            // validates (ping, logging/setLevel) and invoke the list-style
            // commands as best-effort so we at least cover the request
            // encoding path, even though the SDK rejects the empty reply.
            await runMcpc(['connect', serverUrl, sessionArg]);
            await runMcpc([sessionArg]); // session info
            await runMcpc([sessionArg, 'ping']);
            await runMcpc([sessionArg, 'tools-list']);
            await tryMcpc([sessionArg, 'logging-set-level', 'info']);
            await tryMcpc([sessionArg, 'resources-list']);
            await tryMcpc([sessionArg, 'resources-templates-list']);
            await tryMcpc([sessionArg, 'prompts-list']);
            return;

        case 'tools_call':
            // The conformance server exposes an `add_numbers` tool and
            // records a check when the client invokes it with numeric args.
            // We hit the tool via several mcpc argument-parsing paths
            // (key:=value, inline JSON, --task) and exercise the rest of
            // the command surface (tools-get, tools-list, ping).
            await runMcpc(['connect', serverUrl, sessionArg]);
            await runMcpc([sessionArg, 'tools-list']);
            await runMcpc([sessionArg, 'tools-get', 'add_numbers']);
            await runMcpc([sessionArg, 'tools-call', 'add_numbers', 'a:=2', 'b:=3']);
            await runMcpc([sessionArg, 'tools-call', 'add_numbers', '{"a":10,"b":32}']);
            // The server does not advertise the `tasks` capability, so --task
            // must be refused with a server error (exit code 2) rather than
            // silently downgraded to a synchronous call — the flags change the
            // output shape, so a fallback would hand scripts a result where
            // they parse a taskId.
            await runMcpc([sessionArg, 'tools-call', 'add_numbers', 'a:=1', 'b:=1', '--task'], {
                expectExitCode: 2,
            });
            await runMcpc([sessionArg, 'ping']);
            // Best-effort: the SDK server replies with -32601 for methods
            // it has no handler for, which we tolerate so we still exercise
            // mcpc's encoding for these commands.
            await tryMcpc([sessionArg, 'resources-list']);
            await tryMcpc([sessionArg, 'prompts-list']);
            return;

        case 'sse-retry':
            // The conformance server closes the SSE stream mid tool-call
            // and expects the client to reconnect via GET (Last-Event-ID)
            // within the advertised `retry` window, then finishes the
            // response on the reconnected stream.  Keep the scenario lean
            // so timing is dominated by the reconnect window, not by mcpc
            // process startup.  The tool-call is bounded by a local
            // timeout: once the reconnect has happened (well under 2s) the
            // server-side checks are already decided, so we do not need to
            // wait for the eventual tool-call response.
            await runMcpc(['connect', serverUrl, sessionArg]);
            await runMcpc([sessionArg, 'tools-list']);
            await runMcpc([sessionArg, 'tools-call', 'test_reconnection'], {
                timeoutMs: 30000,
                allowTimeout: true,
            });
            return;

        case 'auth/client-credentials-basic':
            // client_secret_basic: mcpc must send grant_type=client_credentials
            // and authenticate with an HTTP Basic header.
            await runClientCredentialsLogin([
                '--client-id',
                requireContext('client_id'),
                '--client-secret',
                requireContext('client_secret'),
            ]);
            return;

        case 'auth/client-credentials-jwt': {
            // private_key_jwt: mcpc must sign a client assertion with the
            // scenario's key.  Write the PEM to the throwaway home dir rather
            // than passing it on the command line — both because mcpc supports
            // a key path and because argv is world-readable via `ps`.
            const keyPath = join(homeDir, 'client-key.pem');
            await writeFile(keyPath, requireContext('private_key_pem'), { mode: 0o600 });
            const flags = ['--client-id', requireContext('client_id'), '--client-key', keyPath];
            if (context.signing_algorithm) {
                flags.push('--client-key-alg', context.signing_algorithm);
            }
            await runClientCredentialsLogin(flags);
            return;
        }

        default:
            console.error(`Scenario not implemented by mcpc conformance adapter: ${scenario}`);
            process.exit(1);
    }
}

try {
    await main();
} catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
} finally {
    await cleanup();
}
