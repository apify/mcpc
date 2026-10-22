// Owned local fixtures: no remote service, funded wallet, or settlement endpoint.
import assert from 'node:assert/strict';
import { appendFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { verifyTypedData } from 'viem';

export const BINARY = Buffer.from([0, 1, 128, 255, ...Buffer.from('café 🌍')]);
const terms = {
  scheme: 'exact',
  network: 'eip155:84532',
  amount: '0',
  asset: '0x1111111111111111111111111111111111111111',
  payTo: '0x2222222222222222222222222222222222222222',
  maxTimeoutSeconds: 60,
  extra: { name: 'USDC', version: '2' },
};

function makeServer(record, allowParentExit = false) {
  const server = new Server(
    { name: 'just-bash-local-fixture', version: '1.0.0' },
    { capabilities: { tools: {}, resources: { subscribe: true } } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await record({ event: 'list' });
    return {
      tools: ['echo', 'env', 'fail', 'wait', 'break', 'paid'].map((name) => ({
        name,
        inputSchema: { type: 'object', additionalProperties: true },
        ...(name === 'paid' && { _meta: { x402: { paymentRequired: true, accepts: [terms] } } }),
      })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const args = params.arguments ?? {};
    await record({ event: 'call', name: params.name, marker: args.marker });
    if (params.name === 'break') {
      assert(allowParentExit, 'only the owned stdio fixture may stop its own bridge');
      process.kill(process.ppid, 'SIGKILL');
      await new Promise(() => {});
    }
    if (params.name === 'wait') {
      if (args.barrier) {
        await waitForFile(String(args.barrier));
      } else {
        await new Promise((resolve) => setTimeout(resolve, Number(args.millis ?? 500)));
      }
      await record({ event: 'finished', name: params.name, marker: args.marker });
    }
    const text =
      params.name === 'env' ? (process.env[String(args.name)] ?? '') : JSON.stringify(args);
    return {
      content: [{ type: 'text', text }],
      ...(params.name === 'fail' && { isError: true }),
    };
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: 'fixture://binary', name: 'binary' },
      { uri: 'fixture://large', name: 'large' },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    await record({ event: 'read', uri: params.uri });
    return {
      contents: [
        {
          uri: params.uri,
          mimeType: 'application/octet-stream',
          blob: (params.uri === 'fixture://large' ? Buffer.alloc(512 * 1024, 65) : BINARY).toString(
            'base64'
          ),
        },
      ],
    };
  });
  server.setRequestHandler(SubscribeRequestSchema, async ({ params }) => {
    await record({ event: 'subscribe', uri: params.uri });
    return {};
  });
  return server;
}

export async function startHttpFixture(token) {
  const events = [];
  const transports = new Map();
  const record = async (event) => {
    events.push(event);
  };
  const http = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${token}`) {
        events.push({ event: 'unauthorized' });
        res.writeHead(401).end();
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) : undefined;
      if (body?.method === 'tools/call' && body.params.name === 'paid') {
        const encoded = req.headers['payment-signature'];
        if (encoded === undefined) {
          // Exercise the real challenge-first middleware too: immediately after
          // recovery the bridge need not have populated its tool metadata cache.
          const required = {
            x402Version: 2,
            accepts: [terms],
            resource: {
              url: `http://127.0.0.1:${http.address().port}/mcp`,
              description: 'Owned zero-value fixture',
              mimeType: 'application/json',
            },
          };
          events.push({ event: 'payment-challenge' });
          res.writeHead(402, {
            'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(required)).toString('base64'),
          });
          res.end();
          return;
        }
        assert.equal(
          typeof encoded,
          'string',
          'full session grant must preserve saved x402 signing'
        );
        const payment = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
        const authorization = payment.payload.authorization;
        assert.equal(authorization.value, '0');
        assert.equal(authorization.to.toLowerCase(), terms.payTo);
        assert.deepEqual(body.params._meta['x402/payment'], payment);
        const valid = await verifyTypedData({
          address: authorization.from,
          domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: terms.asset },
          types: {
            TransferWithAuthorization: [
              { name: 'from', type: 'address' },
              { name: 'to', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'validAfter', type: 'uint256' },
              { name: 'validBefore', type: 'uint256' },
              { name: 'nonce', type: 'bytes32' },
            ],
          },
          primaryType: 'TransferWithAuthorization',
          message: {
            ...authorization,
            value: BigInt(authorization.value),
            validAfter: BigInt(authorization.validAfter),
            validBefore: BigInt(authorization.validBefore),
          },
          signature: payment.payload.signature,
        });
        assert(valid, 'zero-value test payment signature must verify locally');
        events.push({ event: 'verified-payment' });
      }
      const id = req.headers['mcp-session-id'];
      let transport = transports.get(id);
      if (!transport && req.method === 'POST' && !id) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (session) => transports.set(session, transport),
        });
        await makeServer(record).connect(transport);
      }
      if (!transport) {
        res.writeHead(405).end();
        return;
      }
      await transport.handleRequest(req, res, body);
    } catch (error) {
      events.push({ event: 'fixture-error', message: String(error) });
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${http.address().port}/mcp`,
    events,
    async close() {
      for (const transport of transports.values()) await transport.close();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

async function waitForFile(path) {
  const deadline = Date.now() + 30_000;
  while (
    !(await access(path).then(
      () => true,
      () => false
    ))
  ) {
    assert(Date.now() < deadline, 'the host did not release the fixture barrier');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const recordPath = process.argv[2];
  assert(recordPath, 'an owned event file is required');
  const bridgePid = process.ppid;
  const record = (event) =>
    appendFile(recordPath, JSON.stringify({ ...event, pid: process.pid, bridgePid }) + '\n');
  process.stdin.once('end', () => process.exit(0));
  await record({ event: 'start' });
  const initializeBarrier = process.argv[3];
  if (initializeBarrier) {
    await record({ event: 'awaiting-initialize', barrier: initializeBarrier });
    await waitForFile(initializeBarrier);
  }
  await makeServer(record, true).connect(new StdioServerTransport());
}
