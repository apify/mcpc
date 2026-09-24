/**
 * Unit tests for the SDK transport shim that carries the 2026-07-28 tasks extension
 * (src/core/tasks-transport-shim.ts).
 *
 * The shim exists because SDK 2.0.0 refuses `tasks/get`/`tasks/cancel` on a modern
 * connection and rejects `resultType: "task"` before any result schema runs. These tests
 * drive a fake transport the way the SDK client does — set `onmessage`, call `send` —
 * and check that exactly those two things are rewritten and nothing else changes.
 */

import { vi } from 'vitest';
import {
  TasksTransportShim,
  aliasTaskMethod,
  withTaskRoutingHeader,
  encodeHeaderValue,
  CREATED_TASK_META_KEY,
} from '../../../src/core/tasks-transport-shim.js';

/** A transport stub with a private field and a getter, like the SDK's HTTP transport. */
class FakeTransport {
  #sessionId = 'sess-1';
  sent: unknown[] = [];
  onmessage?: (message: unknown, extra?: unknown) => void;
  onclose?: () => void;
  get sessionId(): string {
    return this.#sessionId;
  }
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async send(message: unknown): Promise<void> {
    this.sent.push(message);
  }
  async terminateSession(): Promise<string> {
    return this.#sessionId;
  }
}

function wrapped(): { raw: FakeTransport; shim: TasksTransportShim; transport: FakeTransport } {
  const raw = new FakeTransport();
  const shim = new TasksTransportShim();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transport = shim.wrap(raw as any) as unknown as FakeTransport;
  return { raw, shim, transport };
}

describe('TasksTransportShim', () => {
  it('forwards ordinary property access and method calls to the transport', async () => {
    const { transport } = wrapped();
    // Getter and private field reached through the proxy, method bound to the target
    expect(transport.sessionId).toBe('sess-1');
    await expect(transport.terminateSession()).resolves.toBe('sess-1');
    expect(typeof transport.terminateSession).toBe('function');
  });

  it('restores the real method name of an aliased request on send', async () => {
    const { raw, transport } = wrapped();
    await transport.send({
      jsonrpc: '2.0',
      id: 1,
      method: aliasTaskMethod('tasks/get'),
      params: { taskId: 't-1' },
    });
    expect(raw.sent[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/get',
      params: { taskId: 't-1' },
    });
  });

  it('leaves other outbound messages alone', async () => {
    const { raw, transport } = wrapped();
    const request = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } };
    await transport.send(request);
    expect(raw.sent[0]).toBe(request);
  });

  it('rewrites a CreateTaskResult into a placeholder tool result carrying the task', () => {
    const { raw, shim, transport } = wrapped();
    const seen = vi.fn();
    transport.onmessage = seen;

    raw.onmessage?.({
      jsonrpc: '2.0',
      id: 3,
      result: {
        resultType: 'task',
        taskId: 't-1',
        status: 'working',
        createdAt: 'now',
        lastUpdatedAt: 'now',
        ttlMs: null,
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 's', version: '1' } },
      },
    });

    expect(seen).toHaveBeenCalledTimes(1);
    const delivered = seen.mock.calls[0]![0] as { result: Record<string, unknown> };
    expect(delivered.result.resultType).toBe('complete');
    expect(delivered.result.content).toEqual([]);
    expect(delivered.result.isError).toBe(true);
    const meta = delivered.result._meta as Record<string, unknown>;
    // The server's own _meta survives next to the stash
    expect(meta['io.modelcontextprotocol/serverInfo']).toEqual({ name: 's', version: '1' });
    expect(shim.takeCreatedTask(delivered.result)).toEqual({
      taskId: 't-1',
      status: 'working',
      createdAt: 'now',
      lastUpdatedAt: 'now',
      ttlMs: null,
    });
  });

  it('passes every other inbound message through untouched', () => {
    const { raw, shim, transport } = wrapped();
    const seen = vi.fn();
    transport.onmessage = seen;

    const legacyCreate = { jsonrpc: '2.0', id: 4, result: { task: { taskId: 't' } } };
    const plain = { jsonrpc: '2.0', id: 5, result: { resultType: 'complete', content: [] } };
    const notification = { jsonrpc: '2.0', method: 'notifications/tasks', params: {} };
    for (const message of [legacyCreate, plain, notification]) raw.onmessage?.(message);

    expect(seen.mock.calls.map((call) => call[0])).toEqual([legacyCreate, plain, notification]);
    expect(shim.takeCreatedTask(plain.result)).toBeUndefined();
  });

  it('recognizes placeholders by identity, so a server cannot forge one', () => {
    const { shim } = wrapped();
    const forged = {
      content: [],
      _meta: { [CREATED_TASK_META_KEY]: { taskId: 'evil', status: 'working' } },
    };
    expect(shim.takeCreatedTask(forged)).toBeUndefined();
    expect(shim.takeCreatedTask(undefined)).toBeUndefined();
    expect(shim.takeCreatedTask({ content: [] })).toBeUndefined();
  });

  it("keeps the SDK's own onmessage chaining working", () => {
    const { raw, transport } = wrapped();
    const previous = vi.fn();
    transport.onmessage = previous;
    // The SDK reads the existing handler back and chains it
    const existing = transport.onmessage;
    const next = vi.fn();
    transport.onmessage = (message: unknown) => {
      existing?.(message);
      next(message);
    };
    raw.onmessage?.({ jsonrpc: '2.0', id: 1, result: { resultType: 'complete' } });
    expect(previous).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('aliasTaskMethod', () => {
  it('never produces a spec method name', () => {
    for (const method of ['tasks/get', 'tasks/cancel', 'tasks/update'] as const) {
      const alias = aliasTaskMethod(method);
      expect(alias).not.toBe(method);
      expect(alias.endsWith(method)).toBe(true);
      expect(alias.includes('/')).toBe(true);
    }
  });
});

describe('encodeHeaderValue', () => {
  it('passes plain ASCII through and base64-encodes the rest', () => {
    expect(encodeHeaderValue('786512e2-9e0d-44bd-8f29-789f320fe840')).toBe(
      '786512e2-9e0d-44bd-8f29-789f320fe840'
    );
    expect(encodeHeaderValue('úkol')).toBe(`=?base64?${Buffer.from('úkol').toString('base64')}?=`);
    expect(encodeHeaderValue(' padded ')).toMatch(/^=\?base64\?.*\?=$/);
    expect(encodeHeaderValue('=?base64?x?=')).toMatch(/^=\?base64\?.*\?=$/);
    expect(encodeHeaderValue('')).toBe('=?base64??=');
  });
});

describe('withTaskRoutingHeader', () => {
  function post(body: unknown, headers: HeadersInit = {}): RequestInit {
    return { method: 'POST', headers: new Headers(headers), body: JSON.stringify(body) };
  }

  function headersSentBy(fetchFn: ReturnType<typeof vi.fn>): Headers {
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    return new Headers(init.headers);
  }

  it('adds Mcp-Name: <taskId> to tasks/get, tasks/update and tasks/cancel requests', async () => {
    for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
      const inner = vi.fn().mockResolvedValue(new Response('{}'));
      const fetchFn = withTaskRoutingHeader(inner);
      await fetchFn(
        'https://s/mcp',
        post({ jsonrpc: '2.0', id: 1, method, params: { taskId: 't-1' } })
      );
      expect(headersSentBy(inner).get('mcp-name')).toBe('t-1');
    }
  });

  it('encodes a task id that is not a plain header value', async () => {
    const inner = vi.fn().mockResolvedValue(new Response('{}'));
    await withTaskRoutingHeader(inner)(
      'https://s/mcp',
      post({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { taskId: 'úkol' } })
    );
    expect(headersSentBy(inner).get('mcp-name')).toBe(encodeHeaderValue('úkol'));
  });

  it('leaves other requests and pre-set headers alone', async () => {
    const inner = vi.fn().mockResolvedValue(new Response('{}'));
    const fetchFn = withTaskRoutingHeader(inner);

    const call = post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tasks/x' } });
    await fetchFn('https://s/mcp', call);
    expect(inner).toHaveBeenLastCalledWith('https://s/mcp', call);

    const preset = post(
      { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId: 't-1' } },
      { 'mcp-name': 'already' }
    );
    await fetchFn('https://s/mcp', preset);
    expect(inner).toHaveBeenLastCalledWith('https://s/mcp', preset);

    const get: RequestInit = { method: 'GET' };
    await fetchFn('https://s/mcp', get);
    expect(inner).toHaveBeenLastCalledWith('https://s/mcp', get);

    await fetchFn('https://s/mcp', { method: 'POST', body: 'not json "tasks/get' });
    expect(inner).toHaveBeenLastCalledWith('https://s/mcp', {
      method: 'POST',
      body: 'not json "tasks/get',
    });
  });
});
