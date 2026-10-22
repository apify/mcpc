/** Same-OS-user trust boundary for proxy management and its credential delivery. */
import { lstat, mkdir, realpath } from 'fs/promises';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'path';
import { ClientError } from './errors.js';
import { getMcpcHome, getSessionsFilePath } from './utils.js';

export function assertProxyControlPlatform(): void {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    throw new ClientError(
      'Named proxy management is not supported on this platform: IPC ownership has not been verified. ' +
        'The existing connect --proxy workflow remains available.'
    );
  }
}

/**
 * A private leaf is insufficient when another user can replace an ancestor. Root
 * owned sticky directories (/tmp) are safe for an owned child; arbitrary writable
 * ancestors and user-controlled symlinks are not. Root-owned system aliases such
 * as macOS /var → /private/var are checked again through their canonical path.
 */
async function checkDirectoryPath(
  path: string,
  options: { create?: boolean; privateLeaf?: boolean } = {},
  aliases = 0
): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined || !isAbsolute(path)) throw new ClientError('Unverified IPC directory.');
  const absolute = resolve(path);
  let cursor = parse(absolute).root;
  let parentProtected = true;
  for (const part of absolute.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    let stat;
    try {
      stat = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !options.create) throw error;
      await mkdir(cursor, { mode: 0o700 });
      stat = await lstat(cursor);
    }
    if (stat.isSymbolicLink()) {
      // Permit only protected OS aliases, never aliases at the private namespace itself.
      const systemAlias =
        process.platform === 'darwin' && ['/var', '/tmp', '/etc'].includes(cursor);
      if (
        !systemAlias ||
        stat.uid !== 0 ||
        !parentProtected ||
        cursor === absolute ||
        aliases >= 8
      ) {
        throw new ClientError(`Refusing proxy IPC path ${cursor}: symbolic link.`);
      }
      const canonical = await realpath(cursor);
      await checkDirectoryPath(canonical, {}, aliases + 1);
      parentProtected = ((await lstat(canonical)).mode & 0o022) === 0;
      continue;
    }
    if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0)) {
      throw new ClientError(`Refusing proxy IPC directory ${cursor}: untrusted owner or type.`);
    }
    const writable = (stat.mode & 0o022) !== 0;
    const rootSticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (writable && !rootSticky) {
      throw new ClientError(`Refusing proxy IPC directory ${cursor}: writable by another user.`);
    }
    parentProtected = !writable;
    if (cursor === absolute && options.privateLeaf) {
      if (stat.uid !== uid || (stat.mode & 0o077) !== 0) {
        throw new ClientError(
          `Refusing proxy IPC directory ${cursor}: it must be owned by you with mode 0700.`
        );
      }
    }
  }
}

export async function verifyProxyHome(create = false): Promise<void> {
  assertProxyControlPlatform();
  await checkDirectoryPath(getMcpcHome(), { create, privateLeaf: true });
  try {
    const stat = await lstat(getSessionsFilePath());
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new ClientError(
        'Refusing proxy management: sessions.json must be an owned private regular file.'
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Called by the bridge before bind, and the CLI before connecting/sending credentials. */
export async function verifyBridgeNamespace(socketPath: string, create = false): Promise<void> {
  await verifyProxyHome(create);
  await checkDirectoryPath(dirname(socketPath), { create, privateLeaf: true });
}

export async function verifyBridgeEndpoint(socketPath: string): Promise<void> {
  await verifyBridgeNamespace(socketPath);
  const stat = await lstat(socketPath);
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) {
    throw new ClientError('Refusing proxy IPC endpoint: untrusted socket owner or type.');
  }
}
