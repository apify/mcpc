/**
 * Unit tests for session storage helpers: clearSessionMcpSessionId and the
 * auto-restart handling of expired sessions in consolidateSessions.
 *
 * Drives the real module against a tmp MCPC_HOME_DIR.
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  saveSession,
  getSession,
  clearSessionMcpSessionId,
  consolidateSessions,
} from '../../../src/lib/sessions.js';
import type { SessionData } from '../../../src/lib/types.js';

describe('sessions storage', () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'mcpc-sessions-test-'));
    originalHome = process.env.MCPC_HOME_DIR;
    process.env.MCPC_HOME_DIR = homeDir;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.MCPC_HOME_DIR;
    else process.env.MCPC_HOME_DIR = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  function baseSession(overrides: Partial<SessionData> = {}): Omit<SessionData, 'name'> {
    return {
      server: { url: 'https://mcp.example.com' },
      createdAt: '2026-01-01T00:00:00Z',
      ...overrides,
    };
  }

  describe('clearSessionMcpSessionId', () => {
    it('removes the stored MCP session id', async () => {
      await saveSession('@test', baseSession({ mcpSessionId: 'abc-123' }));

      await clearSessionMcpSessionId('@test');

      const session = await getSession('@test');
      expect(session).toBeDefined();
      expect(session?.mcpSessionId).toBeUndefined();
    });

    it('is a no-op when no MCP session id is stored', async () => {
      await saveSession('@test', baseSession());
      await expect(clearSessionMcpSessionId('@test')).resolves.toBeUndefined();
    });

    it('throws for unknown sessions', async () => {
      await expect(clearSessionMcpSessionId('@missing')).rejects.toThrow(/Session not found/);
    });
  });

  describe('consolidateSessions auto-restart of expired sessions', () => {
    // An old lastConnectionAttemptAt / lastSeenAt, outside the restart cooldown window
    const LONG_AGO = '2026-01-01T00:00:00Z';

    it('marks expired auto-restart sessions for restart and drops the session id', async () => {
      await saveSession(
        '@expired-auto',
        baseSession({
          status: 'expired',
          autoRestart: true,
          mcpSessionId: 'stale-id',
          lastSeenAt: LONG_AGO,
          lastConnectionAttemptAt: LONG_AGO,
        })
      );

      const result = await consolidateSessions(false);

      expect(result.sessionsToRestart).toContain('@expired-auto');
      const session = result.sessions['@expired-auto'];
      expect(session?.status).toBe('reconnecting');
      // The rejected MCP session id must be dropped so the restarted bridge
      // connects fresh instead of retrying resumption forever
      expect(session?.mcpSessionId).toBeUndefined();

      const persisted = await getSession('@expired-auto');
      expect(persisted?.status).toBe('reconnecting');
      expect(persisted?.mcpSessionId).toBeUndefined();
    });

    it('picks up expired auto-restart sessions whose dead bridge pid is cleared in the same pass', async () => {
      // Realistic post-expiry state: the bridge marked the session expired and shut
      // down, but its (now dead) pid is still recorded. A single consolidation pass
      // must clear the pid AND schedule the restart.
      await saveSession(
        '@expired-dead-pid',
        baseSession({
          status: 'expired',
          autoRestart: true,
          mcpSessionId: 'stale-id',
          pid: 2 ** 30, // beyond Linux pid_max — never a live process
          lastSeenAt: LONG_AGO,
          lastConnectionAttemptAt: LONG_AGO,
        })
      );

      const result = await consolidateSessions(false);

      expect(result.sessionsToRestart).toContain('@expired-dead-pid');
      const session = result.sessions['@expired-dead-pid'];
      expect(session?.pid).toBeUndefined();
      expect(session?.status).toBe('reconnecting');
      expect(session?.mcpSessionId).toBeUndefined();
    });

    it('leaves expired sessions without auto-restart untouched', async () => {
      await saveSession(
        '@expired-manual',
        baseSession({
          status: 'expired',
          mcpSessionId: 'stale-id',
          lastSeenAt: LONG_AGO,
          lastConnectionAttemptAt: LONG_AGO,
        })
      );

      const result = await consolidateSessions(false);

      expect(result.sessionsToRestart).not.toContain('@expired-manual');
      const session = result.sessions['@expired-manual'];
      expect(session?.status).toBe('expired');
      expect(session?.mcpSessionId).toBe('stale-id');
    });

    it('respects the restart cooldown for expired auto-restart sessions', async () => {
      await saveSession(
        '@expired-recent',
        baseSession({
          status: 'expired',
          autoRestart: true,
          mcpSessionId: 'stale-id',
          lastSeenAt: LONG_AGO,
          lastConnectionAttemptAt: new Date().toISOString(),
        })
      );

      const result = await consolidateSessions(false);

      expect(result.sessionsToRestart).not.toContain('@expired-recent');
      expect(result.sessions['@expired-recent']?.status).toBe('expired');
    });
  });
});
