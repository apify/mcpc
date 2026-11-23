/** A host-authorized bridge from just-bash to this installed package's CLI. */
import { spawn } from 'child_process';
import { realpathSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import { constants, homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import type { Command, ExecResult, ResolvedCommandContext } from 'just-bash';

// Closed deliberately: new CLI commands and flags do not acquire host authority
// automatically. Counts are positional arguments after the command name.
const COMMAND_ARGUMENTS = {
  info: [0, 0],
  'tools-list': [0, 0],
  'tools-get': [1, 1],
  'tools-call': [1, Infinity],
  'tasks-list': [0, 0],
  'tasks-get': [1, 1],
  'tasks-result': [1, 1],
  'tasks-cancel': [1, 1],
  'resources-list': [0, 0],
  'resources-read': [1, 1],
  'resources-templates-list': [0, 0],
  'resources-directory-read': [1, 1],
  'skills-list': [0, 0],
  'skills-get': [1, 2],
  'prompts-list': [0, 0],
  'prompts-get': [1, Infinity],
  'completion-complete': [2, Infinity],
  'logging-set-level': [1, 1],
  ping: [0, 0],
  'server-discover': [0, 0],
} as const;

export type McpcJustBashSessionCommand = keyof typeof COMMAND_ARGUMENTS;

export interface McpcJustBashSessionGrant {
  /**
   * Includes saved credentials, payments, stdio processes, proxies, subscriptions,
   * and initial/retry bridge recovery. Even discovery may exercise these powers.
   */
  authority: 'full-session-lifecycle';
  /** Each command needs a grant; in particular tools-call is never implied. */
  commands: readonly McpcJustBashSessionCommand[];
}

export interface McpcJustBashOptions {
  /** Host-created dedicated directory, required when granting any sessions. */
  homeDir?: string;
  /** No sessions are granted by default. Keys include the @ prefix. */
  sessions?: Readonly<Record<string, McpcJustBashSessionGrant>>;
  /** Host cwd, captured when creating the adapter; never the virtual shell cwd. */
  cwd?: string;
  /** Complete child environment, defaulting to a snapshot of the host environment. */
  env?: NodeJS.ProcessEnv;
  /** Overall invocation deadline, including CLI startup. Default: 60,000. */
  timeoutMillis?: number;
  /** Time between SIGTERM and SIGKILL. Default: 250. */
  killGraceMillis?: number;
  /** Combined UTF-8 argv and raw stdin bytes. Default: 1 MiB. */
  maxInputBytes?: number;
  /** Combined captured child stdout/stderr bytes. Default: 8 MiB. */
  maxOutputBytes?: number;
}

export interface McpcJustBashCommand extends Command {
  /**
   * Sessions accessed by this adapter, recorded before launching each CLI.
   * Their detached bridges belong to the host, including after cancellation.
   * This is a conservative ownership ledger, not a live process inventory.
   */
  getAccessedSessions(): readonly string[];
}

const HELP = `mcpc <@session> <command> [arguments] [--json]

The host must configure createMcpcJustBashCommand with explicit session lifecycle
and command grants. No sessions are granted by the default mcpcJustBashCommand.
Use shell pipes and redirection for virtual files; host file/config/auth commands
and flags are unavailable. Detached session bridges remain owned by the host.
`;

const failure = (message: string, exitCode = 1): ExecResult => ({
  stdout: '',
  stderr: `mcpc: ${message}\n`,
  exitCode,
});

function positiveInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function isCommand(value: string): value is McpcJustBashSessionCommand {
  return Object.hasOwn(COMMAND_ARGUMENTS, value);
}

function parseArgs(args: string[]): {
  session: string;
  command: McpcJustBashSessionCommand;
  argv: string[];
} {
  const positionals: string[] = [];
  const flags = new Map<string, string | undefined>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) throw new Error('arguments must not contain empty slots');
    if (arg.includes('\0')) throw new Error('NUL bytes are not allowed in arguments');
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    const separator = arg.indexOf('=');
    const name = separator < 0 ? arg : arg.slice(0, separator);
    if (flags.has(name)) throw new Error(`duplicate option: ${name}`);
    if (name === '--timeout' || name === '--max-chars') {
      const value = separator < 0 ? args[++index] : arg.slice(separator + 1);
      if (
        value === undefined ||
        !/^\d+(?:\.\d+)?$/.test(value) ||
        !Number.isFinite(Number(value))
      ) {
        throw new Error(`${name} requires a finite non-negative number`);
      }
      if (name === '--timeout' ? Number(value) <= 0 : !Number.isSafeInteger(Number(value))) {
        throw new Error(`invalid value for ${name}`);
      }
      flags.set(name, value);
    } else if (
      separator < 0 &&
      ['--json', '--verbose', '--full', '--raw', '--task', '--detach'].includes(name)
    ) {
      flags.set(name, undefined);
    } else {
      // In particular reject --, short aliases, help/version anywhere, and all
      // path/config/auth/payment flags, including their --flag=value spellings.
      throw new Error(`option is not available in the just-bash adapter: ${name}`);
    }
  }
  const session = positionals.shift();
  if (!session || !/^@[a-zA-Z0-9_-]{1,64}$/.test(session)) {
    throw new Error('an explicitly granted @session is required; global commands are unavailable');
  }
  const rawCommand = positionals.shift();
  const command = rawCommand?.includes('/')
    ? rawCommand
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .toLowerCase()
        .replaceAll('/', '-')
    : (rawCommand ?? 'info');
  if (!isCommand(command)) throw new Error(`command is not available in the adapter: ${command}`);
  const [minimum, maximum] = COMMAND_ARGUMENTS[command];
  if (positionals.length < minimum || positionals.length > maximum) {
    throw new Error(`invalid argument count for ${command}`);
  }
  for (const flag of flags.keys()) {
    if (
      (flag === '--full' && command !== 'tools-list') ||
      (flag === '--raw' && command !== 'resources-read' && command !== 'skills-get') ||
      ((flag === '--task' || flag === '--detach') && command !== 'tools-call')
    ) {
      throw new Error(`${flag} is not available for ${command}`);
    }
  }
  const argv = [session, ...(command === 'info' ? [] : [command]), ...positionals];
  for (const [flag, value] of flags) argv.push(flag, ...(value === undefined ? [] : [value]));
  return { session, command, argv };
}

/**
 * Creates a trusted host command, not an OS sandbox. The home must contain only
 * fully granted sessions; the host provisions them and owns their teardown.
 */
export function createMcpcJustBashCommand(options: McpcJustBashOptions = {}): McpcJustBashCommand {
  const grants = new Map<string, ReadonlySet<McpcJustBashSessionCommand>>();
  for (const [session, grant] of Object.entries(options.sessions ?? {})) {
    if (!/^@[a-zA-Z0-9_-]{1,64}$/.test(session)) throw new TypeError(`invalid session: ${session}`);
    if (grant.authority !== 'full-session-lifecycle') {
      throw new TypeError(`${session} requires an explicit full-session-lifecycle authority grant`);
    }
    if (!Array.isArray(grant.commands) || grant.commands.some((item) => !isCommand(item))) {
      throw new TypeError(`${session} contains an unsupported command grant`);
    }
    grants.set(session, new Set(grant.commands));
  }
  let homeDir: string | undefined;
  if (options.homeDir !== undefined) {
    if (!isAbsolute(options.homeDir)) throw new TypeError('homeDir must be an absolute host path');
    homeDir = realpathSync(options.homeDir);
    if (!statSync(homeDir).isDirectory())
      throw new TypeError('homeDir must be a host-created directory');
    const defaultHome = join(homedir(), '.mcpc');
    let resolvedDefaultHome = resolve(defaultHome);
    try {
      resolvedDefaultHome = realpathSync(defaultHome);
    } catch {
      // The default collection need not exist.
    }
    if (homeDir === resolvedDefaultHome)
      throw new TypeError('homeDir must not be the default ~/.mcpc collection');
  }
  if (grants.size > 0 && homeDir === undefined)
    throw new TypeError('session grants require homeDir');
  const cwd = realpathSync(options.cwd ?? process.cwd());
  if (!statSync(cwd).isDirectory()) throw new TypeError('cwd must be a host directory');
  const env = { ...(options.env ?? process.env), ...(homeDir && { MCPC_HOME_DIR: homeDir }) };
  const executable = process.execPath;
  const cliPath = fileURLToPath(new URL('../cli/index.js', import.meta.url));
  const timeoutMillis = positiveInteger(
    options.timeoutMillis ?? 60_000,
    'timeoutMillis',
    2_147_483_647
  );
  const killGraceMillis = positiveInteger(
    options.killGraceMillis ?? 250,
    'killGraceMillis',
    2_147_483_647
  );
  const maxInputBytes = positiveInteger(options.maxInputBytes ?? 1024 * 1024, 'maxInputBytes');
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes ?? 8 * 1024 * 1024,
    'maxOutputBytes'
  );
  const accessedSessions = new Set<string>();

  return {
    name: 'mcpc',
    trusted: true,
    getAccessedSessions: () => [...accessedSessions],
    async execute(args, ctx) {
      const startedAt = performance.now();
      if (ctx.signal?.aborted) return failure('canceled', 130);
      ctx.executionScope?.throwIfAborted();
      if (
        args.length === 0 ||
        (args.length === 1 && ['help', '--help', '-h'].includes(args[0] ?? ''))
      ) {
        return { stdout: HELP, stderr: '', exitCode: 0 };
      }
      let invocation: ReturnType<typeof parseArgs>;
      try {
        if (args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg) + 1, 0) > maxInputBytes) {
          throw new Error('input limit exceeded');
        }
        invocation = parseArgs(args);
        if (!grants.get(invocation.session)?.has(invocation.command)) {
          throw new Error(
            `session or command not granted: ${invocation.session} ${invocation.command}`
          );
        }
        if (homeDir === undefined) throw new Error('session grants require a dedicated home');
        const content: unknown = JSON.parse(await readFile(join(homeDir, 'sessions.json'), 'utf8'));
        const sessions =
          content && typeof content === 'object' && 'sessions' in content ? content.sessions : null;
        if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {
          throw new Error('invalid dedicated session store');
        }
        if (Object.keys(sessions).some((session) => !grants.has(session))) {
          throw new Error('dedicated home contains an ungranted session');
        }
        if (!Object.hasOwn(sessions, invocation.session))
          throw new Error('granted session is not provisioned');
        for (const [name, value] of Object.entries(sessions)) {
          if (!value || typeof value !== 'object' || !('name' in value) || value.name !== name) {
            throw new Error('dedicated session store contains an inconsistent session identity');
          }
        }
      } catch (error) {
        if (ctx.signal?.aborted) return failure('canceled', 130);
        return failure(error instanceof Error ? error.message : 'invalid invocation');
      }
      // The CLI stays usable without just-bash installed; only a real integration
      // invocation loads its byte-boundary helpers. Never import the CLI itself.
      const encoding = await import('just-bash');
      const stdin = encoding.latin1FromBytes(ctx.stdin);
      const argvBytes = invocation.argv.reduce(
        (bytes, arg) => bytes + Buffer.byteLength(arg) + 1,
        0
      );
      if (stdin.length + argvBytes > maxInputBytes) return failure('input limit exceeded');
      if (ctx.signal?.aborted) return failure('canceled', 130);
      ctx.executionScope?.throwIfAborted();
      const remainingMillis = Math.min(
        timeoutMillis - (performance.now() - startedAt),
        ctx.executionScope?.remainingTimeMs() ?? Infinity
      );
      if (remainingMillis <= 0) return failure('deadline exceeded', 124);
      const inputLease = ctx.executionScope?.reserveBytes(stdin.length, 'mcpc stdin');
      // Record before spawn: cancellation can race detached bridge initialization
      // and sessions.json persistence. A PID snapshot cannot establish ownership.
      accessedSessions.add(invocation.session);
      try {
        const result = await runCli(
          executable,
          [cliPath, ...invocation.argv],
          { cwd, env, remainingMillis, killGraceMillis, maxOutputBytes },
          Buffer.from(stdin, 'latin1'),
          ctx
        );
        return {
          ...encoding.bytesOutput(encoding.unsafeBytesFromLatin1(result.stdout.toString('latin1'))),
          stderr: result.stderr.toString('utf8') + result.diagnostic,
          exitCode: result.exitCode,
        };
      } finally {
        inputLease?.release();
      }
    },
  };
}

interface ProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  diagnostic: string;
  exitCode: number;
}

async function runCli(
  executable: string,
  argv: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    remainingMillis: number;
    killGraceMillis: number;
    maxOutputBytes: number;
  },
  input: Buffer,
  ctx: ResolvedCommandContext
): Promise<ProcessResult> {
  const child = spawn(executable, argv, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const leases: { release(): void }[] = [];
  let capturedBytes = 0;
  let stopped: { code: number; message: string } | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const stop = (code: number, message: string): void => {
    if (stopped || closed) return;
    stopped = { code, message };
    child.stdin.destroy();
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), options.killGraceMillis);
  };
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('error', () => {
        stopped ??= { code: 127, message: 'could not launch the installed CLI' };
      });
      child.once('close', (code, signal) => {
        closed = true;
        resolve({ code, signal });
      });
    }
  );
  const capture = (chunks: Buffer[], chunk: Buffer): void => {
    if (stopped) return;
    const available = options.maxOutputBytes - capturedBytes;
    const kept = chunk.subarray(0, available);
    try {
      // Allow for the final Buffer.concat and output string as well as chunks.
      const lease = ctx.executionScope?.reserveBytes(kept.length * 3, 'mcpc output');
      if (lease) leases.push(lease);
      // Do not retain a larger pipe buffer through a small subarray at the cap.
      chunks.push(Buffer.from(kept));
      capturedBytes += kept.length;
    } catch {
      stop(125, 'output memory limit exceeded');
      return;
    }
    if (chunk.length > available) stop(125, 'output limit exceeded');
  };
  child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
  child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
  const abort = (): void => stop(130, 'canceled; session bridges remain owned by the host');
  ctx.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    () => stop(124, 'deadline exceeded; session bridges remain owned by the host'),
    options.remainingMillis
  );
  let unregisterCleanup: (() => void) | undefined;
  try {
    unregisterCleanup = ctx.executionScope?.registerCleanup(async () => {
      abort();
      await completion;
    });
    if (ctx.signal?.aborted) abort();
    const inputFinished = pipeline(
      Readable.from(
        (function* () {
          for (let offset = 0; offset < input.length; offset += 16 * 1024) {
            yield input.subarray(offset, offset + 16 * 1024);
          }
        })()
      ),
      child.stdin
    ).catch((error: NodeJS.ErrnoException) => {
      if (
        !closed &&
        !stopped &&
        error.code !== 'EPIPE' &&
        error.code !== 'ERR_STREAM_PREMATURE_CLOSE'
      ) {
        stop(125, 'could not write CLI stdin');
      }
    });
    const result = await completion;
    await inputFinished;
    return {
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      diagnostic: stopped ? `mcpc: ${stopped.message}\n` : '',
      exitCode:
        stopped?.code ??
        result.code ??
        128 + (result.signal ? (constants.signals[result.signal] ?? 1) : 1),
    };
  } finally {
    if (!closed) {
      abort();
      await completion;
    }
    clearTimeout(timeout);
    clearTimeout(killTimer);
    ctx.signal?.removeEventListener('abort', abort);
    unregisterCleanup?.();
    for (const lease of leases) lease.release();
  }
}

/** Convenient deny-by-default command; use the factory to grant any session. */
export const mcpcJustBashCommand = createMcpcJustBashCommand();
