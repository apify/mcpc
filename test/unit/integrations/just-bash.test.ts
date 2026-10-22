import { EventEmitter } from 'events';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { PassThrough, Writable } from 'stream';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import {
  createCommandContext,
  encodeUtf8ToBytes,
  InMemoryFs,
  unsafeBytesFromLatin1,
} from 'just-bash';
import { vi } from 'vitest';
import {
  createMcpcJustBashCommand,
  mcpcJustBashCommand,
  type McpcJustBashOptions,
} from '../../../src/integrations/just-bash.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('child_process', () => ({ spawn: spawnMock }));

let homeDir: string;
let children: ReturnType<typeof fakeChild>[];

function fakeChild() {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const input: Buffer[] = [];
  stdin.on('data', (chunk: Buffer) => input.push(chunk));
  let closed = false;
  const finish = (code = 0, signal: NodeJS.Signals | null = null) => {
    if (closed) return;
    closed = true;
    stdin.destroy();
    stdout.end();
    stderr.end();
    events.emit('close', code, signal);
  };
  const kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    queueMicrotask(() => finish(0, signal));
    return true;
  });
  const child = Object.assign(events, { stdin, stdout, stderr, kill, pid: 12345 });
  return {
    child: child as unknown as ChildProcessWithoutNullStreams,
    stdin,
    stdout,
    stderr,
    input,
    kill,
    finish,
  };
}

function context(input = '', signal?: AbortSignal) {
  return createCommandContext({
    fs: new InMemoryFs(),
    cwd: '/guest',
    env: new Map([
      ['MCPC_HOME_DIR', '/guest/credentials'],
      ['HOME', '/guest'],
      ['PATH', '/guest/bin'],
      ['NODE_OPTIONS', '--import=/guest/steal.mjs'],
      ['HTTPS_PROXY', 'http://guest.invalid'],
    ]),
    stdin: encodeUtf8ToBytes(input),
    ...(signal && { signal }),
  });
}

function command(overrides: Partial<McpcJustBashOptions> = {}) {
  return createMcpcJustBashCommand({
    homeDir,
    sessions: {
      '@test': {
        authority: 'full-session-lifecycle',
        commands: ['info', 'tools-list', 'tools-get', 'tools-call', 'resources-read'],
      },
    },
    ...overrides,
  });
}

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'mcpc-just-bash-unit-'));
  await writeFile(
    join(homeDir, 'sessions.json'),
    JSON.stringify({ sessions: { '@test': { name: '@test' } } })
  );
  children = [];
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const child = fakeChild();
    children.push(child);
    child.stdin.on('finish', () => {
      child.stdout.write(Buffer.concat(child.input));
      child.finish();
    });
    return child.child;
  });
});

afterEach(async () => {
  for (const child of children) child.finish();
  await rm(homeDir, { recursive: true, force: true });
});

describe('just-bash authority and argument boundary', () => {
  it('has no ambient session authority, including the convenient default command', async () => {
    expect((await mcpcJustBashCommand.execute([], context())).stdout).toContain(
      'createMcpcJustBashCommand'
    );
    expect((await mcpcJustBashCommand.execute(['@test', 'tools-list'], context())).exitCode).toBe(
      1
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('requires a full-lifecycle grant and a host-created home', () => {
    expect(() =>
      command({
        sessions: { '@test': { authority: 'read-only' as never, commands: ['tools-list'] } },
      })
    ).toThrow(/full-session-lifecycle/);
    expect(() => command({ homeDir: 'relative' })).toThrow(/absolute/);
    expect(() => command({ homeDir: join(homeDir, 'missing') })).toThrow();
    expect(() =>
      command({
        sessions: {
          '@test': { authority: 'full-session-lifecycle', commands: ['connect' as never] },
        },
      })
    ).toThrow(/command/);
  });

  it('rejects a home containing any session outside the full grants', async () => {
    await writeFile(
      join(homeDir, 'sessions.json'),
      JSON.stringify({ sessions: { '@test': {}, '@private': { bridgePid: 999 } } })
    );
    const result = await command().execute(['@test', 'tools-list'], context());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/ungranted session/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects a stored identity that could redirect recovery to another session', async () => {
    await writeFile(
      join(homeDir, 'sessions.json'),
      JSON.stringify({ sessions: { '@test': { name: '@private' } } })
    );
    const result = await command().execute(['@test', 'tools-list'], context());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('inconsistent session identity');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    ['connect', 'https://mcp.apify.com', '@new'],
    ['login', 'https://mcp.apify.com'],
    ['clean', 'sessions'],
    ['grep', 'private'],
    ['x402', 'balance'],
    ['@private', 'tools-list'],
    ['@test', 'restart'],
    ['@test', 'close'],
    ['@test', 'resources-subscribe', 'resource://x', '/tmp/host-file'],
    ['--profile=private', '@test', 'tools-list'],
    ['@test', 'tools-get', 'echo', '--schema', '/tmp/private.json'],
    ['@test', 'tools-call', 'echo', '--schema-mode=ignore'],
    ['@test', 'resources-read', 'resource://x', '-o', '/tmp/host-file'],
    ['@test', 'resources-read', 'resource://x', '--output=/tmp/host-file'],
    ['@test', 'tools-list', '--insecure'],
    ['@test', 'tools-call', 'echo', '--x402-max-amount=100'],
    ['@test', 'tools-call', 'echo', '--proxy', '8000'],
    ['@test', 'tools-call', 'echo', '--', '--profile', 'private'],
    ['@test', 'tools-call', 'echo', '--help'],
    ['@test', 'tools-call', 'echo', '-v'],
    ['@test', 'tools-call', 'echo', '--version'],
    ['@test', 'tools-list', '--json=true'],
    ['@test', 'tools-list', '--raw'],
    ['@test', 'tools-list', '--timeout', 'NaN'],
    ['@test', 'tools-list', '--timeout=1', '--timeout=2'],
    ['@test', 'tools-list', 'unexpected'],
    ['@test', 'tools-call', 'echo\0bad'],
  ])('rejects unauthorized or ambiguous argv before a child starts: %j', async (...args) => {
    const result = await command().execute(args, context());
    expect(result.exitCode).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('checks the canonical command grant, including slash aliases and side effects', async () => {
    const adapter = command({
      sessions: { '@test': { authority: 'full-session-lifecycle', commands: ['tools-list'] } },
    });
    expect((await adapter.execute(['@test', 'tools/call', 'echo'], context())).exitCode).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
    expect((await adapter.execute(['--json', '@test', 'tools/list'], context())).exitCode).toBe(0);
    expect(spawnMock.mock.calls[0]?.[1].slice(1)).toEqual(['@test', 'tools-list', '--json']);
  });

  it('pins the installed CLI, environment, cwd, and argument boundaries', async () => {
    const env = { PATH: '/host/bin', HOME: homeDir, HOST_MARKER: 'captured' };
    const adapter = command({ env, cwd: homeDir });
    env.HOST_MARKER = 'changed';
    const literal = 'value:=hello; $(touch /host/file) `whoami` @private';
    const result = await adapter.execute(['@test', 'tools-call', 'echo', literal], context());
    expect(result.exitCode).toBe(0);
    const [executable, argv, options] = spawnMock.mock.calls[0]!;
    expect(executable).toBe(process.execPath);
    expect(argv[0]).toMatch(/[/\\]cli[/\\]index\.js$/);
    expect(argv.slice(1)).toEqual(['@test', 'tools-call', 'echo', literal]);
    expect(options).toMatchObject({ shell: false, cwd: homeDir });
    expect(options.env).toEqual({ ...env, HOST_MARKER: 'captured', MCPC_HOME_DIR: homeDir });
    expect(adapter.getAccessedSessions()).toEqual(['@test']);
  });

  it('snapshots grants rather than following caller mutations', async () => {
    const commands: ('tools-list' | 'tools-call')[] = ['tools-list'];
    const adapter = command({
      sessions: { '@test': { authority: 'full-session-lifecycle', commands } },
    });
    commands.push('tools-call');
    expect((await adapter.execute(['@test', 'tools-call', 'echo'], context())).exitCode).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('just-bash process and byte boundaries', () => {
  it('preserves UTF-8 stdin and arbitrary binary stdout without double encoding', async () => {
    const input = 'こんにちは 🌍 café';
    const result = await command().execute(['@test', 'tools-call', 'echo'], context(input));
    expect(result.stdoutKind).toBe('bytes');
    expect(Buffer.from(result.stdout, 'latin1').toString('utf8')).toBe(input);
    const binary = Buffer.from([0, 128, 255, 10]);
    const ctx = context();
    ctx.stdin = unsafeBytesFromLatin1(binary.toString('latin1'));
    const binaryResult = await command().execute(['@test', 'tools-call', 'echo'], ctx);
    expect(Buffer.from(binaryResult.stdout, 'latin1')).toEqual(binary);
  });

  it('preserves independent stderr and the CLI exit status', async () => {
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      children.push(child);
      child.stdin.on('finish', () => {
        child.stdout.write('result');
        const warning = Buffer.from('warning: café');
        child.stderr.write(warning.subarray(0, warning.length - 1));
        child.stderr.write(warning.subarray(warning.length - 1));
        child.finish(2);
      });
      return child.child;
    });
    expect(await command().execute(['@test', 'tools-list'], context())).toMatchObject({
      stdout: 'result',
      stderr: 'warning: café',
      exitCode: 2,
    });
  });

  it('rejects oversized input before spawning and bounds captured output', async () => {
    expect(
      (
        await command({ maxInputBytes: 128 }).execute(
          ['@test', 'tools-list'],
          context('é'.repeat(100))
        )
      ).exitCode
    ).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      children.push(child);
      child.stdin.on('finish', () => child.stdout.write(Buffer.alloc(4096, 97)));
      return child.child;
    });
    const result = await command({ maxOutputBytes: 128 }).execute(
      ['@test', 'tools-list'],
      context()
    );
    expect(result.exitCode).toBe(125);
    expect(result.stdout.length).toBeLessThanOrEqual(128);
    expect(result.stderr).toContain('output limit');
    expect(children[0]?.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not spawn when already canceled or canceled during preflight', async () => {
    const signal = AbortSignal.abort();
    expect((await command().execute(['@test', 'tools-list'], context('', signal))).exitCode).toBe(
      130
    );
    const controller = new AbortController();
    const running = command().execute(['@test', 'tools-list'], context('', controller.signal));
    controller.abort();
    expect((await running).exitCode).toBe(130);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each(['abort', 'timeout'])(
    'escalates an uncooperative child on %s and records persistent ownership',
    async (reason) => {
      const controller = new AbortController();
      spawnMock.mockImplementation(() => {
        const child = fakeChild();
        children.push(child);
        child.kill.mockImplementation((signal) => {
          if (signal === 'SIGKILL') queueMicrotask(() => child.finish(0, signal));
          return true;
        });
        if (reason === 'abort') child.stdin.on('finish', () => controller.abort());
        return child.child;
      });
      const adapter = command({ timeoutMillis: 50, killGraceMillis: 5 });
      const result = await adapter.execute(['@test', 'tools-list'], context('', controller.signal));
      expect(result.exitCode).toBe(reason === 'abort' ? 130 : 124);
      expect(children[0]?.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
      expect(adapter.getAccessedSessions()).toEqual(['@test']);
    }
  );

  it('honors writable backpressure rather than queueing the whole input', async () => {
    let largestBufferedWrite = 0;
    let received = 0;
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      children.push(child);
      const sink = new Writable({
        highWaterMark: 1024,
        write(chunk: Buffer, _encoding, callback) {
          largestBufferedWrite = Math.max(largestBufferedWrite, this.writableLength);
          received += chunk.length;
          setImmediate(callback);
        },
      });
      sink.on('finish', () => child.finish());
      child.child.stdin = sink;
      return child.child;
    });
    const result = await command().execute(
      ['@test', 'tools-call', 'echo'],
      context('x'.repeat(256 * 1024))
    );
    expect(result.exitCode).toBe(0);
    expect(received).toBe(256 * 1024);
    expect(largestBufferedWrite).toBeLessThanOrEqual(32 * 1024);
  });

  it('registers bounded scope cleanup and releases owned accounting', async () => {
    let cleanup: (() => void | Promise<void>) | undefined;
    const release = vi.fn();
    const unregister = vi.fn();
    const ctx = context();
    ctx.executionScope = {
      remainingLiveBytes: 1024 * 1024,
      consumeWork: () => 0,
      consumeLimited: () => 0,
      consumeInput: () => 0,
      reserveBytes: () => ({ release }),
      enterDepth: () => ({ release }),
      throwIfAborted: () => {},
      remainingTimeMs: () => 1000,
      registerCleanup: (fn) => {
        cleanup = fn;
        return unregister;
      },
    };
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      children.push(child);
      child.stdin.on('finish', () => {
        void cleanup?.();
      });
      return child.child;
    });
    const result = await command().execute(['@test', 'tools-list'], ctx);
    expect(result.exitCode).toBe(130);
    expect(children[0]?.kill).toHaveBeenCalledWith('SIGTERM');
    expect(unregister).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('reports an executable launch failure without returning a success status', async () => {
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      children.push(child);
      queueMicrotask(() => {
        child.child.emit('error', new Error('ENOENT'));
        child.finish(0);
      });
      return child.child;
    });
    const result = await command().execute(['@test', 'tools-list'], context());
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain('could not launch');
  });
});
