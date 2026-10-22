import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./proxy-session-keychain-loader.mjs', import.meta.url);
const { deleteSession, getSession, saveSession, updateSession } =
  await import('../../../src/lib/sessions.ts');
const { claimBridgeOwner } = await import('../../../src/lib/bridge-ownership.ts');

if (process.argv[2] === 'delete') {
  await deleteSession('@deleting');
} else if (process.argv[2] === 'edit') {
  const current = await getSession('@deleting');
  assert.ok(current.deletion?.workerPid);
  await assert.rejects(
    claimBridgeOwner('@deleting', current, 'must-not-claim', process.pid),
    /pending deletion/
  );
  await updateSession('@sibling', { lastSeenAt: 'written by another process' });
  await saveSession('@created-during-cleanup', {
    server: { command: 'fixture' },
    createdAt: '',
    status: 'expired',
  });
} else {
  throw new Error('Unknown session worker action');
}
