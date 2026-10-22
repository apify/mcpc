# Using mcpc in just-bash

Install `@apify/mcpc` and `just-bash` 3.6 or later in a Node.js application. The
package exports `createMcpcJustBashCommand`, which runs the CLI from that same
installation as a child process. It preserves argument boundaries, stdin bytes,
stdout, stderr, and the CLI's numeric exit status. It does not load the CLI into
the application's process or change its console, arguments, environment, signal
handlers, or HTTP dispatcher.

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bash } from 'just-bash';
import { createMcpcJustBashCommand } from '@apify/mcpc';

// These are host operations. Provision the session before exposing the shell.
const cli = createRequire(import.meta.url).resolve('@apify/mcpc/bin/mcpc');
const homeDir = mkdtempSync(join(tmpdir(), 'mcpc-agent-'));
const env = { ...process.env, MCPC_HOME_DIR: homeDir };
execFileSync(process.execPath, [cli, 'connect', 'mcp.apify.com', '@apify'], { env });

const command = createMcpcJustBashCommand({
  homeDir,
  env,
  sessions: {
    '@apify': {
      authority: 'full-session-lifecycle',
      commands: ['tools-list', 'tools-get'],
    },
  },
});
const bash = new Bash({ customCommands: [command] });
const result = await bash.exec('mcpc @apify tools-list --json | jq ".[0].name"');
console.log(result.stdout);

// The host also owns session teardown. Quiesce all its invocations first.
execFileSync(process.execPath, [cli, '@apify', 'close'], { env });
```

The convenient `mcpcJustBashCommand` export has **no session grants**. It shows
adapter help for `mcpc`, `mcpc help`, or `mcpc --help`, and rejects session access.
Use the factory to provide authority. A bare `mcpc` inside this adapter never
enumerates the host's sessions or authentication profiles.

## Session authority

A grant applies to the **entire saved session lifecycle**, including its server
configuration, saved credentials, wallet/payment settings, stdio processes,
proxy listener, resource subscriptions, and initial or retry bridge recovery.
Even `tools-list` can start a configured process, refresh authentication, or
restore a proxy or subscription. Command grants select which requests the guest
may make; they do not restrict those underlying lifecycle effects. `tools-call`
must be granted explicitly and can invoke any tool that the session permits.
There is no read-only or no-recovery grant.

Use a host-created, absolute `homeDir` containing only fully granted sessions.
The factory rejects the default `~/.mcpc` collection, and each invocation checks
that every stored session is granted and that its stored name matches its key.
The host provisions and maintains this directory; do not expose it through the
guest filesystem or an MCP tool that can rewrite the session configuration.
The OS keychain remains mcpc's existing shared keychain: the directory is not a
separate keychain namespace. Use distinct session/profile names for independent
applications, and grant only credentials and wallet settings the host intends
that application to exercise.

The adapter is a trusted host integration, not an OS sandbox. A granted stdio
server has the host permissions with which mcpc starts it, and a granted remote
server has the authority of its credentials and tools. The host must choose
these capabilities before passing the command to an untrusted shell.

## Commands and arguments

Each session's `commands` array accepts these names:

| Group | Command grants |
| --- | --- |
| Discovery | `info` (bare `mcpc @session`), `ping`, `server-discover` |
| Tools | `tools-list`, `tools-get`, `tools-call` |
| Tasks | `tasks-list`, `tasks-get`, `tasks-result`, `tasks-cancel` |
| Resources | `resources-list`, `resources-read`, `resources-templates-list`, `resources-directory-read` |
| Skills | `skills-list`, `skills-get` |
| Prompts and completions | `prompts-list`, `prompts-get`, `completion-complete` |
| Logging | `logging-set-level` |

The adapter accepts `--json`, `--verbose`, `--timeout <seconds>`, and
`--max-chars <n>`, plus `--full` for `tools-list`, `--raw` for `resources-read`
and `skills-get`, and `--task`/`--detach` for `tools-call`. Numeric options also
accept `--option=value`. Known MCP method aliases such as `tools/list` are
checked against their canonical command grant. Arguments are passed as an argv
array without a host shell, preserving spaces, quotes, metacharacters, JSON, and
`key:=value` arguments.

The grammar is intentionally closed. It rejects unknown flags, duplicate flags,
`--`, short aliases, and nested `--help`/`--version` flags. For a tool's schema,
grant and use `tools-get`; the normal CLI's `tools-call <tool> --help` shortcut
would otherwise perform a different request. Pass option-looking data inside a
JSON object or `key:=value`, rather than as a separate `--flag` argument.

Global discovery/search, `connect`, authentication, cleanup, restart/close,
wallet commands, and host-path features are unavailable. In particular,
`--schema`, `--output`/`-o`, `--profile`, `--insecure`, payment overrides, and
resource-subscription file arguments cannot reach the CLI. This does not remove
authority already stored in a granted session.

Use virtual shell pipes and redirects instead of host file flags:

```sh
printf '%s' '{"query":"café"}' | mcpc @apify tools-call search --json | jq .
mcpc @files resources-read 'file:///allowed/resource' --raw > /virtual-result.bin
```

`tools-call` and the relevant resource command need explicit grants for those
examples. Resource URIs and skill file names are interpreted by the selected
MCP server, not as local output paths. Binary stdout uses just-bash's public byte
metadata so pipes and redirects do not re-encode it as UTF-8. Stderr remains a
separate UTF-8 diagnostic stream.

## Environment, limits, and cancellation

`cwd` and `env` are host options captured when creating the command. By default
they capture the host's current directory and environment; `env` replaces that
environment when supplied. `MCPC_HOME_DIR` is always set to the selected
`homeDir`. The guest's `ctx.env`, `ctx.cwd`, `PATH`, `HOME`, `NODE_OPTIONS`, and
proxy settings cannot alter the executable, session collection, or child
environment. Changes to the caller's grant arrays or environment object after
construction do not expand the grant.

| Option | Default | Meaning |
| --- | --- | --- |
| `timeoutMillis` | 60,000 | Overall invocation deadline, including startup; the remaining just-bash execution budget can shorten it |
| `killGraceMillis` | 250 | Delay after SIGTERM before escalating an unresponsive CLI to SIGKILL |
| `maxInputBytes` | 1 MiB | Combined UTF-8 argv and raw stdin bytes |
| `maxOutputBytes` | 8 MiB | Combined captured child stdout and stderr bytes; excludes adapter diagnostics |

Stdin is written in bounded chunks through a backpressure-aware pipeline. Output
is collected under the byte cap and just-bash's memory budget. The adapter
registers execution-scope cleanup and removes its listeners, timers, and byte
reservations when the owned CLI finishes. An already-aborted invocation starts
no child process. Cancellation terminates the CLI and returns `130`; a deadline
returns `124`; an output or input-stream failure returns `125`; a launch failure
returns `127`. Policy or input-limit failures return `1`. Other completed CLI
statuses pass through unchanged, including tool failures (`2`).

Detached bridge processes remain **host-owned persistent sessions**. Killing a
CLI cannot safely undo a concurrent bridge initialization, saved subscription,
remote tool call, task, credential refresh, or payment. The adapter does not
retry a command or kill a pre-existing bridge. mcpc's existing session client
may recover a failed bridge; its non-idempotent request handling still reports
uncertainty instead of replaying a tool call after an in-flight socket failure.

`command.getAccessedSessions()` returns a snapshot of session names recorded
before each CLI launch, including launches that fail or are canceled. This is a
conservative host ownership ledger, not a list of live PIDs: a detached bridge
can still be initializing when cancellation finishes. Stop new invocations,
let or supervise pending session initialization, then use the host CLI and the
same `MCPC_HOME_DIR` to close the sessions. Keep the directory until teardown
finishes. Cancellation of one invocation does not remove another invocation's
session, credentials, or bridge.

## Package and test boundaries

`just-bash` is an optional peer dependency. Installing or running the normal CLI,
or importing the deny-by-default command, does not load it. The integration's
JavaScript and TypeScript declarations ship in the npm package; repository
documentation, source, and tests remain excluded.

After `pnpm run build`, run `pnpm run test:just-bash` to pack and install real
temporary consumers, check their declarations, and exercise local MCP fixtures.
The test retains the repository's dependency-age and approved-build-script
policies. `MCPC_JUST_BASH_OFFLINE=1` uses a previously populated package-manager
cache. It tests a zero-value signature against a local payment fixture with an
ephemeral unfunded wallet; it performs no settlement or external service call.
Owned sessions and processes are closed at the end.
