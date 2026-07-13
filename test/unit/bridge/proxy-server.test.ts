/**
 * Unit tests for the proxy MCP server's DNS-rebinding protections.
 *
 * A malicious web page can point an attacker-controlled hostname at 127.0.0.1
 * and drive the proxy (and the authenticated upstream session) from the user's
 * browser. Requests forged that way arrive with a non-local Host and/or Origin
 * header, so the proxy must reject them with 403.
 */

import http from 'http';
import type { AddressInfo } from 'net';
import { ProxyServer } from '../../../src/bridge/proxy-server.js';
import type { McpClient } from '../../../src/core/mcp-client.js';

const onWindows = process.platform === 'win32';

/** Minimal upstream client stub — handlers are never invoked in these tests. */
const stubClient = {} as unknown as McpClient;

function request(options: {
  port: number;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: options.port,
        method: options.method ?? 'GET',
        path: options.path ?? '/health',
        headers: options.headers ?? {},
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Find a free TCP port by binding to 0 and releasing it. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

describe.skipIf(onWindows)('ProxyServer Host/Origin validation', () => {
  let proxy: ProxyServer;
  let port: number;

  beforeAll(async () => {
    port = await freePort();
    proxy = new ProxyServer({
      host: '127.0.0.1',
      port,
      client: stubClient,
      sessionName: '@test',
      version: '0.0.0-test',
    });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
  });

  it('accepts requests with a loopback Host header', async () => {
    const res = await request({ port });
    expect(res.status).toBe(200);
    expect(res.body).toContain('ok');
  });

  it('rejects requests with a non-local Host header (DNS rebinding)', async () => {
    const res = await request({ port, headers: { Host: 'attacker.example.com' } });
    expect(res.status).toBe(403);
    expect(res.body).toContain('Host');
  });

  it('rejects non-local Host with port suffix', async () => {
    const res = await request({ port, headers: { Host: `rebind.evil:${port}` } });
    expect(res.status).toBe(403);
  });

  it('rejects requests with a non-local Origin header', async () => {
    const res = await request({
      port,
      headers: { Host: `127.0.0.1:${port}`, Origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain('Origin');
  });

  it('accepts requests with a loopback Origin header', async () => {
    const res = await request({
      port,
      headers: { Host: `127.0.0.1:${port}`, Origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(200);
  });

  it('requires MCP-Session-Id for non-POST MCP requests', async () => {
    const res = await request({ port, path: '/' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown session ID', async () => {
    const res = await request({
      port,
      path: '/',
      headers: { 'mcp-session-id': 'nonexistent-session' },
    });
    expect(res.status).toBe(404);
  });
});
