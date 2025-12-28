/**
 * Clean command handlers
 * Cleans up mcpc data (sessions, profiles, logs, sockets)
 */

import { readdir, unlink, rm } from 'fs/promises';
import { join } from 'path';
import type { OutputMode } from '../../lib/index.js';
import { getMcpcHome, getBridgesDir, getLogsDir, fileExists, cleanupOrphanedLogFiles } from '../../lib/index.js';
import { formatOutput, formatSuccess } from '../output.js';
import { loadSessions, deleteSession, consolidateSessions } from '../../lib/sessions.js';
import { stopBridge } from '../../lib/bridge-manager.js';
import { createLogger } from '../../lib/logger.js';

const logger = createLogger('clean');

interface CleanOptions {
  outputMode: OutputMode;
  sessions?: boolean;
  profiles?: boolean;
  logs?: boolean;
  all?: boolean;
}

interface CleanResult {
  staleSockets: number;
  deadBridges: number;
  expiredSessions: number;
  orphanedBridgeLogs: number;
  sessions: number;
  profiles: number;
  logs: number;
}

/**
 * Safe cleanup: consolidate sessions, remove stale sockets, and clean orphaned logs
 * This is non-destructive - only cleans up orphaned resources
 */
async function cleanStale(): Promise<{
  staleSockets: number;
  deadBridges: number;
  expiredSessions: number;
  orphanedBridgeLogs: number;
}> {
  // Consolidate sessions (clears dead bridges, removes expired sessions, deletes stale sockets)
  const consolidateResult = await consolidateSessions();

  // Clean up orphaned log files (for sessions that no longer exist, older than 7 days)
  const orphanedBridgeLogs = await cleanupOrphanedLogFiles(consolidateResult.sessions);

  return {
    staleSockets: consolidateResult.staleSockets,
    deadBridges: consolidateResult.deadBridges,
    expiredSessions: consolidateResult.expiredSessions,
    orphanedBridgeLogs,
  };
}

/**
 * Clean all sessions (closes bridges, removes session records and keychain data)
 */
async function cleanSessions(): Promise<number> {
  const sessionsStorage = await loadSessions();
  const sessionNames = Object.keys(sessionsStorage.sessions);
  let count = 0;

  for (const name of sessionNames) {
    try {
      // Stop the bridge if running
      try {
        await stopBridge(name);
      } catch {
        // Bridge may already be stopped
      }

      // Delete session data
      await deleteSession(name);

      count++;
      logger.debug(`Cleaned session: ${name}`);
    } catch (error) {
      logger.warn(`Failed to clean session ${name}:`, error);
    }
  }

  return count;
}

/**
 * Clean all authentication profiles
 */
async function cleanProfiles(): Promise<number> {
  const mcpcHome = getMcpcHome();
  const profilesFile = join(mcpcHome, 'profiles.json');

  if (!(await fileExists(profilesFile))) {
    return 0;
  }

  try {
    await unlink(profilesFile);
    logger.debug('Removed profiles.json');
    // TODO: Also clean keychain entries for OAuth tokens
    return 1;
  } catch {
    return 0;
  }
}

/**
 * Clean all log files
 */
async function cleanLogs(): Promise<number> {
  const logsDir = getLogsDir();

  if (!(await fileExists(logsDir))) {
    return 0;
  }

  let count = 0;
  const files = await readdir(logsDir);

  for (const file of files) {
    if (file.endsWith('.log') || file.match(/\.log\.\d+$/)) {
      try {
        await unlink(join(logsDir, file));
        count++;
      } catch {
        // Ignore errors
      }
    }
  }

  logger.debug(`Removed ${count} log files`);
  return count;
}

/**
 * Clean the entire ~/.mcpc directory using proper cleanup functions
 */
async function cleanAll(): Promise<CleanResult> {
  const result: CleanResult = {
    staleSockets: 0,
    deadBridges: 0,
    expiredSessions: 0,
    orphanedBridgeLogs: 0,
    sessions: 0,
    profiles: 0,
    logs: 0,
  };

  // Clean sessions first (stops bridges, removes keychain data)
  result.sessions = await cleanSessions();

  // Clean auth profiles
  result.profiles = await cleanProfiles();

  // Clean logs
  result.logs = await cleanLogs();

  // Clean any remaining stale sockets and orphaned logs
  const staleResult = await cleanStale();
  result.staleSockets = staleResult.staleSockets;
  result.deadBridges = staleResult.deadBridges;
  result.expiredSessions = staleResult.expiredSessions;
  result.orphanedBridgeLogs = staleResult.orphanedBridgeLogs;

  // Remove any remaining empty directories
  const mcpcHome = getMcpcHome();
  const bridgesDir = getBridgesDir();
  const logsDir = getLogsDir();

  for (const dir of [bridgesDir, logsDir]) {
    if (await fileExists(dir)) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // Ignore errors
      }
    }
  }

  // Try to remove mcpc home if empty
  if (await fileExists(mcpcHome)) {
    try {
      const files = await readdir(mcpcHome);
      if (files.length === 0) {
        await rm(mcpcHome, { recursive: true, force: true });
        logger.debug(`Removed empty ${mcpcHome}`);
      }
    } catch {
      // Ignore errors
    }
  }

  return result;
}

/**
 * Main clean command handler
 */
export async function clean(options: CleanOptions): Promise<void> {
  const result: CleanResult = {
    staleSockets: 0,
    deadBridges: 0,
    expiredSessions: 0,
    orphanedBridgeLogs: 0,
    sessions: 0,
    profiles: 0,
    logs: 0,
  };

  // --all overrides everything
  if (options.all) {
    const allResult = await cleanAll();

    if (options.outputMode === 'human') {
      const parts: string[] = [];
      if (allResult.sessions > 0) parts.push(`${allResult.sessions} session(s)`);
      if (allResult.profiles > 0) parts.push(`${allResult.profiles} profile(s)`);
      if (allResult.logs > 0) parts.push(`${allResult.logs} log file(s)`);
      if (allResult.staleSockets > 0) parts.push(`${allResult.staleSockets} socket(s)`);

      if (parts.length > 0) {
        console.log(formatSuccess(`Cleaned ${parts.join(', ')}`));
      } else {
        console.log(formatSuccess('Nothing to clean'));
      }
    } else {
      console.log(formatOutput(allResult, 'json'));
    }
    return;
  }

  // Determine what to clean
  const cleaningSpecific = options.sessions || options.profiles || options.logs;

  // Always do safe cleanup unless specific options are provided
  if (!cleaningSpecific) {
    const staleResult = await cleanStale();
    result.staleSockets = staleResult.staleSockets;
    result.deadBridges = staleResult.deadBridges;
    result.expiredSessions = staleResult.expiredSessions;
    result.orphanedBridgeLogs = staleResult.orphanedBridgeLogs;
  }

  // Clean specific resources if requested
  if (options.sessions) {
    result.sessions = await cleanSessions();
  }

  if (options.profiles) {
    result.profiles = await cleanProfiles();
  }

  if (options.logs) {
    result.logs = await cleanLogs();
  }

  // Output results
  if (options.outputMode === 'human') {
    const messages: string[] = [];

    if (!cleaningSpecific) {
      const hasCleanups =
        result.deadBridges > 0 ||
        result.staleSockets > 0 ||
        result.expiredSessions > 0 ||
        result.orphanedBridgeLogs > 0;

      if (hasCleanups) {
        const parts: string[] = [];
        if (result.deadBridges > 0) parts.push(`${result.deadBridges} dead bridge(s)`);
        if (result.expiredSessions > 0) parts.push(`${result.expiredSessions} expired session(s)`);
        if (result.staleSockets > 0) parts.push(`${result.staleSockets} stale socket(s)`);
        if (result.orphanedBridgeLogs > 0) parts.push(`${result.orphanedBridgeLogs} orphaned log(s)`);
        messages.push(`Cleaned ${parts.join(', ')}`);
      } else {
        messages.push('No stale resources found');
      }
    }

    if (options.sessions) {
      messages.push(`Removed ${result.sessions} session(s)`);
    }

    if (options.profiles) {
      messages.push(result.profiles > 0 ? 'Removed authentication profiles' : 'No profiles to remove');
    }

    if (options.logs) {
      messages.push(`Removed ${result.logs} log file(s)`);
    }

    for (const msg of messages) {
      console.log(formatSuccess(msg));
    }
  } else {
    console.log(formatOutput(result, 'json'));
  }
}
