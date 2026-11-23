/** Deliberately exits at a durable credential boundary; parent owns all cleanup. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [packageDir, sessionName, name, port, tokenFile, phase] = process.argv.slice(2);
const importBuilt = (name) => import(pathToFileURL(join(packageDir, 'dist/lib', name)).href);
const { getSession } = await importBuilt('sessions.js');
const { reserveProxyListener } = await importBuilt('proxy-listeners.js');
const { storeKeychainProxyListenerToken } = await importBuilt('auth/keychain.js');
const session = await getSession(sessionName);
const owner = { createdAt: session.createdAt, bridgeOwner: session.bridgeOwner, pid: session.pid };
const entry = await reserveProxyListener(sessionName, owner, {
  name,
  host: '127.0.0.1',
  port: Number(port),
  authentication: 'bearer',
});
if (phase === 'after-write') {
  await storeKeychainProxyListenerToken(entry.id, (await readFile(tokenFile, 'utf8')).trim());
}
process.exit(73);
