/**
 * Is the PID recorded for a session still that session's bridge?
 *
 * `sessions.json` remembers each bridge by PID, and `process.kill(pid, 0)` only says that
 * *some* process of the user has that PID. Operating systems recycle PIDs: after a reboot
 * (or once the counter wraps) the number that belonged to a bridge is handed to whatever
 * starts next — a shell, an editor, a build. A CLI that trusted the record would then see
 * the PID "alive", fail to reach its socket, and SIGTERM/SIGKILL that unrelated process
 * while "restarting" the bridge. So nothing in mcpc signals a PID before this module has
 * confirmed it is the bridge it is supposed to be.
 *
 * Two pieces of evidence, each sufficient on its own:
 *
 * 1. The IPC socket. Its path is derived from the session name *and* the PID, and lives in
 *    a directory only this user can reach, so a listener there can only be the bridge that
 *    was spawned with that PID. On Windows a named pipe cannot outlive its process, which
 *    makes "no pipe" definitive there. On Unix the socket file survives a crash or a
 *    reboot, so the probe connects instead of checking for the file.
 * 2. The process command line (Linux `/proc/<pid>/cmdline`, `ps` elsewhere on Unix): the
 *    bridge is `<runtime> <...>/dist/bridge/index.js <sessionName> ...`. Consulted only when
 *    the socket does not answer, so a bridge whose socket file has been swept away (temp
 *    dir cleaners do that) can still be stopped rather than orphaned.
 */

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { connect } from 'net';
import { getSocketPath, isProcessAlive } from './utils.js';
import { createLogger } from './logger.js';

const logger = createLogger('bridge-process');

/** How long a connect to the bridge socket may take before the probe gives up. */
const SOCKET_PROBE_TIMEOUT_MILLIS = 2_000;

/** How long `ps` may take to report a process command line. */
const PS_TIMEOUT_MILLIS = 2_000;

/** Path suffix every bridge process has as its script argument (see getBridgeExecutable). */
const BRIDGE_SCRIPT_SUFFIX = '/dist/bridge/index.js';

/**
 * What the PID recorded for a session turned out to be.
 *
 * - `bridge`: this session's bridge — safe to signal.
 * - `other`: a live process that is not the bridge (the PID was recycled). Never signal it.
 * - `dead`: no process has this PID.
 * - `unknown`: a live process whose identity could not be established (its socket does
 *   not answer and its command line is unreadable). Treated as alive by health checks
 *   and never signalled.
 */
export type BridgeProcessIdentity = 'bridge' | 'other' | 'dead' | 'unknown';

type SocketProbeResult = 'listening' | 'absent' | 'unknown';

/**
 * Try to connect to a bridge socket without sending anything.
 *
 * `listening` means a process accepted the connection. `absent` means nothing listens there
 * (ENOENT: no socket file or pipe; ECONNREFUSED: a socket file whose listener is gone).
 * Any other failure — a timeout, EACCES, EBUSY — means the endpoint exists but could not be
 * reached, so it is reported as `unknown`.
 */
function probeBridgeSocket(socketPath: string): Promise<SocketProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect(socketPath);
    const finish = (result: SocketProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish('unknown'), SOCKET_PROBE_TIMEOUT_MILLIS);
    socket.once('connect', () => finish('listening'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? 'absent' : 'unknown');
    });
  });
}

/**
 * Whether a command line (argv split into tokens) is a bridge for `sessionName`: the token
 * that names the bridge script is directly followed by the session name, which is how
 * startBridge() lays the arguments out. Exported for tests.
 */
export function commandLineNamesBridge(tokens: string[], sessionName: string): boolean {
  const scriptIndex = tokens.findIndex((token) =>
    token.replace(/\\/g, '/').endsWith(BRIDGE_SCRIPT_SUFFIX)
  );
  return scriptIndex >= 0 && tokens[scriptIndex + 1] === sessionName;
}

/**
 * The command line of a live process as argv-like tokens, or undefined when it cannot be
 * read (Windows, a process of another user, no /proc, no `ps`).
 *
 * On Linux /proc gives the exact argv. Elsewhere on Unix `ps` prints the arguments joined by
 * spaces, so an argument that itself contains spaces is split — harmless here, because the
 * two tokens that matter (the bridge script and the session name right after it) contain
 * none, and only the tail of the script path is compared.
 */
function readProcessCommandLine(pid: number): string[] | undefined {
  if (process.platform === 'win32') {
    return undefined;
  }
  if (process.platform === 'linux') {
    try {
      const tokens = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (tokens[tokens.length - 1] === '') tokens.pop(); // trailing NUL
      return tokens;
    } catch (error) {
      logger.debug(`Cannot read /proc/${pid}/cmdline:`, error);
      return undefined;
    }
  }
  try {
    const output = execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PS_TIMEOUT_MILLIS,
    }).trim();
    return output ? output.split(/\s+/) : undefined;
  } catch (error) {
    logger.debug(`Cannot read the command line of PID ${pid} with ps:`, error);
    return undefined;
  }
}

/**
 * Establish whether `pid` is the bridge of `sessionName` (see the module comment).
 */
export async function identifyBridgeProcess(
  sessionName: string,
  pid: number
): Promise<BridgeProcessIdentity> {
  const probe = await probeBridgeSocket(getSocketPath(sessionName, pid));
  if (probe !== 'absent') {
    // Only the bridge spawned with this PID creates this endpoint. `unknown` means it is
    // there but did not accept the connection in time — still the bridge, just busy.
    return 'bridge';
  }
  if (!isProcessAlive(pid)) {
    return 'dead';
  }
  const commandLine = readProcessCommandLine(pid);
  if (commandLine === undefined) {
    // A Windows pipe dies with its process: no pipe means PID `pid` is not a bridge.
    // Elsewhere, an unreadable command line leaves the question open.
    const identity: BridgeProcessIdentity = process.platform === 'win32' ? 'other' : 'unknown';
    logger.debug(`PID ${pid} of ${sessionName} is alive but its socket is gone: ${identity}`);
    return identity;
  }
  if (commandLineNamesBridge(commandLine, sessionName)) {
    logger.debug(`PID ${pid} is the bridge of ${sessionName} but its socket is gone`);
    return 'bridge';
  }
  logger.debug(`PID ${pid} recorded for ${sessionName} belongs to another process now`);
  return 'other';
}

/**
 * Whether a session's recorded PID may still be its bridge: true for a confirmed bridge
 * and for a live process that could not be identified, false for a dead or recycled PID.
 * The liveness answer for health checks and session listings; signalling a PID requires
 * a confirmed `bridge` from identifyBridgeProcess() instead.
 */
export async function isBridgeProcess(sessionName: string, pid: number): Promise<boolean> {
  const identity = await identifyBridgeProcess(sessionName, pid);
  return identity === 'bridge' || identity === 'unknown';
}
