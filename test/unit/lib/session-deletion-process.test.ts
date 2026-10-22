import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

it('preserves another process’s writes across synchronous cleanup longer than lock staleness', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcpc-delete-process-'));
  const worker = fileURLToPath(new URL('../fixtures/proxy-session-worker.mjs', import.meta.url));
  const start = (action: string) => {
    const child = spawn(process.execPath, ['--import', 'tsx', worker, action], {
      env: { ...process.env, MCPC_HOME_DIR: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const finished = new Promise<{ code: number | null; output: string }>((resolve) => {
      child.once('error', (error) => resolve({ code: -1, output: error.message }));
      child.once('close', (code) => resolve({ code, output }));
    });
    return { child, finished, output: () => output };
  };
  let deleting: ReturnType<typeof start> | undefined;
  let editing: ReturnType<typeof start> | undefined;
  try {
    await writeFile(
      join(home, 'sessions.json'),
      JSON.stringify({
        sessions: {
          '@deleting': {
            name: '@deleting',
            createdAt: '2026-01-01T00:00:00Z',
            server: {},
            proxyListeners: [
              {
                id: 'cbd85e39-4c04-4639-b4ba-9defd51c8996',
                name: 'listener',
                host: '127.0.0.1',
                port: 8001,
                authentication: 'bearer',
                state: 'stopped',
              },
            ],
          },
          '@sibling': { name: '@sibling', createdAt: '2026-01-01T00:00:00Z', server: {} },
        },
      }),
      { mode: 0o600 }
    );
    deleting = start('delete');
    let entered = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      entered = await readFile(join(home, 'cleanup-entered'), 'utf8').then(
        () => true,
        () => false
      );
      if (entered || deleting.child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(entered, `delete must enter the credential fixture: ${deleting.output()}`).toBe(true);
    // withFileLock uses a 10-second stale interval. The first process remains
    // synchronously blocked through that boundary while a second writer enters.
    await new Promise((resolve) => setTimeout(resolve, 10_500));
    editing = start('edit');
    const edited = await editing.finished;
    expect(edited.code, edited.output).toBe(0);
    expect(deleting.child.exitCode).toBeNull();
    await writeFile(join(home, 'cleanup-release'), 'release');
    const deleted = await deleting.finished;
    expect(deleted.code, deleted.output).toBe(0);
    const result = JSON.parse(await readFile(join(home, 'sessions.json'), 'utf8'));
    expect(result.sessions['@deleting']).toBeUndefined();
    expect(result.sessions['@sibling'].lastSeenAt).toBe('written by another process');
    expect(result.sessions['@created-during-cleanup']).toBeDefined();
  } finally {
    await writeFile(join(home, 'cleanup-release'), 'release').catch(() => {});
    for (const running of [editing, deleting]) {
      if (!running) continue;
      if (running.child.exitCode === null) running.child.kill();
      await running.finished;
    }
    await rm(home, { recursive: true, force: true });
  }
}, 40_000);
