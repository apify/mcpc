import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function removeKeychainProxyListenerToken() {
  const home = process.env.MCPC_HOME_DIR;
  writeFileSync(join(home, 'cleanup-entered'), String(Date.now()));
  const deadline = Date.now() + 30_000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  // A native keychain prompt can block the event loop and lock heartbeat. Use
  // the same synchronous blocking behavior, with a parent-owned release file.
  while (!existsSync(join(home, 'cleanup-release'))) {
    if (Date.now() >= deadline) throw new Error('Credential fixture timed out');
    Atomics.wait(wait, 0, 0, 25);
  }
  return true;
}

export const removeKeychainSessionHeaders = () => true;
export const removeKeychainSessionEnv = () => true;
export const removeKeychainProxyBearerToken = () => true;
