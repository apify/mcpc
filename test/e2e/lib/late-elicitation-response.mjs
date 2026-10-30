import { connect } from 'node:net';
import { getSession } from '../../../dist/lib/sessions.js';
import { getSocketPath } from '../../../dist/lib/utils.js';

const sessionName = process.argv[2];
const session = await getSession(sessionName);
const socket = connect(getSocketPath(sessionName, session.pid));
let buffer = '';
let cancelled = false;
let requests = 0;
const invalidResponse = process.argv[3] === 'invalid';
const deadline = setTimeout(() => {
  console.error('Timed out waiting for the tool result');
  process.exitCode = 1;
  socket.destroy();
}, 5000);

socket.on('connect', () => {
  socket.write(
    `${JSON.stringify({
      type: 'request',
      id: 'tool-call',
      method: 'callTool',
      elicitation: true,
      params: { name: 'request_input', arguments: { timeoutSecond: true } },
    })}\n`
  );
});
socket.on('data', (data) => {
  buffer += data.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    const message = JSON.parse(line);
    if (invalidResponse && message.type === 'elicitation-request') {
      requests++;
      cancelled = true;
      socket.write(
        `${JSON.stringify({
          type: 'elicitation-response',
          id: 'tool-call',
          elicitationId: message.elicitationId,
          elicitationResult: { action: requests === 1 ? 'invalid' : 'cancel' },
        })}\n`
      );
    }
    if (message.type === 'elicitation-cancel') {
      cancelled = true;
      socket.write(
        `${JSON.stringify({
          type: 'elicitation-response',
          id: 'tool-call',
          elicitationId: message.elicitationId,
          elicitationResult: { action: 'accept', content: { name: 'late' } },
        })}\n`
      );
    }
    if (message.type === 'response') {
      clearTimeout(deadline);
      const actions =
        message.result && JSON.parse(message.result.content[0].text).map((item) => item.action);
      if (!cancelled || message.error || actions?.join(',') !== 'cancel,cancel') {
        console.error(
          'Late response incorrectly completed the tool call:',
          JSON.stringify(message)
        );
        process.exitCode = 1;
      }
      socket.end();
    }
  }
});
socket.on('error', (error) => {
  clearTimeout(deadline);
  console.error(error.message);
  process.exitCode = 1;
});
