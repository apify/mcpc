/**
 * Tests for the sessions.json helpers behind the bridge's task record (src/lib/sessions.ts):
 * modifySession must compose concurrent edits of the same field instead of letting the
 * last writer replace the others' snapshot — on 2026-07-28 connections the task record
 * is the session's only handle on the tasks it created.
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getSession,
  modifySession,
  saveSession,
  updateSession,
} from '../../../src/lib/sessions.js';
import type { ActiveTaskEntry } from '../../../src/lib/types.js';

const entry = (taskId: string): ActiveTaskEntry => ({
  taskId,
  toolName: 'slow-task',
  createdAt: '2026-10-06T00:00:00.000Z',
});

describe('modifySession', () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpc-sessions-test-'));
    originalHome = process.env.MCPC_HOME_DIR;
    process.env.MCPC_HOME_DIR = homeDir;
    await saveSession('@tasks', {
      server: { url: 'https://example.test/mcp' },
      status: 'active',
      createdAt: '2026-10-06T00:00:00.000Z',
      activeTasks: { t0: entry('t0') },
    });
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.MCPC_HOME_DIR;
    else process.env.MCPC_HOME_DIR = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('composes concurrent edits of the task record', async () => {
    // Two tasks recorded while a third is pruned, all at once: every edit must land.
    await Promise.all([
      modifySession('@tasks', (session) => ({
        activeTasks: { ...session.activeTasks, t1: entry('t1') },
      })),
      modifySession('@tasks', (session) => ({
        activeTasks: { ...session.activeTasks, t2: entry('t2') },
      })),
      modifySession('@tasks', (session) => {
        const { t0: _pruned, ...activeTasks } = session.activeTasks ?? {};
        return { activeTasks };
      }),
    ]);

    const session = await getSession('@tasks');
    expect(Object.keys(session?.activeTasks ?? {}).sort()).toEqual(['t1', 't2']);
  });

  it('leaves the session untouched when the mutation returns undefined', async () => {
    const before = await getSession('@tasks');
    await modifySession('@tasks', () => undefined);
    expect(await getSession('@tasks')).toEqual(before);
  });

  it('keeps the fields the update does not name, and the name', async () => {
    await updateSession('@tasks', { status: 'expired' });
    const session = await getSession('@tasks');
    expect(session?.status).toBe('expired');
    expect(session?.name).toBe('@tasks');
    expect(session?.server).toEqual({ url: 'https://example.test/mcp' });
    expect(session?.activeTasks).toEqual({ t0: entry('t0') });
  });

  it('refuses an unknown session', async () => {
    await expect(modifySession('@missing', () => ({}))).rejects.toThrow(
      'Session not found: @missing'
    );
  });
});
