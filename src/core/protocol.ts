/**
 * MCP protocol version constants and helpers.
 *
 * Deliberately dependency-free: the CLI imports this module on every invocation
 * (for `--protocol-version` validation and help text), so it must not pull in the MCP
 * SDK. The legacy list mirrors the SDK's `SUPPORTED_PROTOCOL_VERSIONS` (the
 * versions its `initialize` handshake can offer/accept) and the modern list
 * mirrors its internal `SUPPORTED_MODERN_PROTOCOL_VERSIONS`; a unit test guards
 * against drift on SDK upgrades.
 */

import { SKILLS_EXTENSION_KEY, TASKS_EXTENSION_KEY } from './extensions.js';

/** Modern-era protocol revisions (2026-07-28 and later), newest first. */
export const MODERN_PROTOCOL_VERSIONS: readonly string[] = ['2026-07-28'];

/** Legacy-era protocol revisions negotiated via the `initialize` handshake, newest first. */
export const LEGACY_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];

/** All protocol revisions mcpc can pin via `--protocol-version`, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  ...MODERN_PROTOCOL_VERSIONS,
  ...LEGACY_PROTOCOL_VERSIONS,
];

/**
 * `_meta` key under which 2026-07-28 servers stamp their identity on every response.
 * Mirrors the SDK's `SERVER_INFO_META_KEY` — spelled out here so the CLI can read it
 * without loading the SDK (a unit test guards against drift).
 */
export const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

/** Whether a protocol revision belongs to the modern (2026-07-28+) era. */
export function isModernProtocolVersion(version: string): boolean {
  return MODERN_PROTOCOL_VERSIONS.includes(version);
}

/** Whether a protocol revision can be pinned via `--protocol-version`. */
export function isSupportedProtocolVersion(version: string): boolean {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(version);
}

/**
 * Explain that a 2026-07-28 server never declared the tasks extension. On that protocol
 * generation tasks exist only as the `io.modelcontextprotocol/tasks` extension, and a
 * server that does not declare it serves no `tasks/*` request and never hands out a task,
 * so mcpc says so instead of firing requests the server has no obligation to recognize.
 * Lives here (rather than in the core client) so the CLI — which gates `tools-call
 * --task/--detach` before dispatching, and must not load the SDK at startup — reports the
 * identical reason.
 *
 * Intentionally has no trailing period. The task messages surface either straight from
 * the CLI (where period-less errors are the house style) or relayed from the bridge, which
 * appends ". For details, run: mcpc @session logs" — a period here would double up.
 */
export function tasksNotDeclaredMessage(sessionName?: string): string {
  const session = sessionName ?? '@session';
  return (
    `This server does not declare the ${TASKS_EXTENSION_KEY} extension, so it cannot run ` +
    `tools as tasks (--task/--detach) and serves no tasks-* command. ` +
    `Run "mcpc ${session}" to see what this server supports`
  );
}

/**
 * Explain that a 2025-11-25 server does not offer task-augmented tool calls, even though
 * the protocol has them. Kept next to {@link tasksNotDeclaredMessage} for the same
 * reason: both the CLI and the bridge refuse `--task`/`--detach` with this text.
 *
 * Same no-trailing-period convention as above.
 */
export function tasksUnsupportedByServerMessage(): string {
  return (
    `This server does not support task-augmented tool calls ` +
    `(no tasks.requests.tools.call capability), so --task/--detach cannot be used. ` +
    `Re-run the command without them to call the tool synchronously`
  );
}

/**
 * Explain that the 2026-07-28 tasks extension has no `tasks/list`: a client only knows
 * the tasks it created. mcpc tracks those per session, which is what `tasks-list` shows
 * there — this message is for the raw protocol path that cannot fall back to that record.
 *
 * Same no-trailing-period convention as above.
 */
export function tasksListUnavailableMessage(protocolVersion?: string): string {
  return (
    `tasks/list does not exist in MCP ${protocolVersion ?? MODERN_PROTOCOL_VERSIONS[0]}: the ` +
    `${TASKS_EXTENSION_KEY} extension lets a client follow only the tasks it created`
  );
}

/**
 * Explain why a task that asks for input cannot make progress with mcpc: it never
 * prompts (design rule — no unexpected interaction loops), so the elicitation or sampling
 * request a task surfaces via `inputRequests` has no one to answer it. `methods` names the
 * outstanding requests so the user can tell what the server wanted.
 *
 * Same no-trailing-period convention as above.
 */
export function taskInputRequiredMessage(taskId: string, methods: readonly string[]): string {
  const wanted = methods.length > 0 ? ` (${methods.join(', ')})` : '';
  return (
    `Task ${taskId} is waiting for input from the client${wanted}, which mcpc cannot provide ` +
    `(it never prompts and has no LLM). The task stays on the server until it is answered, ` +
    `times out, or is cancelled with tasks-cancel ${taskId}`
  );
}

/**
 * Explain why `server-discover` does not work on a legacy connection. `server/discover`
 * was introduced by 2026-07-28; the 2025-era handshake carries the same information in its
 * `initialize` result, which mcpc already keeps for the session.
 *
 * Same no-trailing-period convention as the task messages above.
 */
export function discoverUnavailableMessage(protocolVersion?: string, sessionName?: string): string {
  const session = sessionName ?? '@session';
  return (
    `server/discover is not available on this connection: it was introduced in MCP ` +
    `${MODERN_PROTOCOL_VERSIONS[0]}, and this connection negotiated ` +
    `${protocolVersion ?? 'an older version'}, where the initialize handshake carries the same ` +
    `information. Run "mcpc ${session}" to see it, or "mcpc ${session} ping" to check liveness`
  );
}

/**
 * Explain why skill commands do not work on a legacy connection. The extension is
 * specified against base revision 2026-07-28 or later — its results carry the modern
 * era's `resultType`/`ttlMs`/`cacheScope` — so mcpc refuses to speak it on a 2025-era
 * connection rather than guessing at a dialect no server promises to serve.
 *
 * Same no-trailing-period convention as the messages above.
 */
export function skillsUnavailableMessage(protocolVersion?: string, sessionName?: string): string {
  const session = sessionName ?? '@session';
  return (
    `Skills are not available on this connection: the ${SKILLS_EXTENSION_KEY} extension is ` +
    `specified against MCP ${MODERN_PROTOCOL_VERSIONS[0]} and later, and this connection ` +
    `negotiated ${protocolVersion ?? 'an older version'}. Run "mcpc ${session}" to see what ` +
    `this server supports`
  );
}

/**
 * Explain that the server never declared the extension. Clients issue `skills/list` and
 * `skills/get` only after observing the declaration, so mcpc says so instead of firing a
 * request the server has no obligation to recognize.
 */
export function skillsNotDeclaredMessage(sessionName?: string): string {
  const session = sessionName ?? '@session';
  return (
    `This server does not declare the ${SKILLS_EXTENSION_KEY} extension, so it serves no ` +
    `skills. Run "mcpc ${session} resources-list" to see what it does serve`
  );
}

/**
 * Explain that directory reads are off. `resources/directory/read` is optional and
 * clients MUST NOT call it unless the server declared `directoryRead: true`.
 */
export function directoryReadUnavailableMessage(sessionName?: string): string {
  const session = sessionName ?? '@session';
  return (
    `This server does not support resources/directory/read (the ${SKILLS_EXTENSION_KEY} ` +
    `extension is declared without "directoryRead": true), so directories cannot be listed. ` +
    `Run "mcpc ${session} resources-list" to see the resources it serves`
  );
}
