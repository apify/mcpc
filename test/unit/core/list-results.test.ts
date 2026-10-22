/** Real SDK + HTTP transport: each response below is one protocol page, never an aggregate. */
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpClient } from '../../../src/core/mcp-client.js';
import { fetchAllPagesResult } from '../../../src/lib/utils.js';

type Key = 'tools' | 'prompts' | 'resources' | 'tasks';
type Page = Record<string, unknown>;

const items: Record<Key, Page> = {
  tools: { name: 'first', inputSchema: { type: 'object' } },
  prompts: { name: 'first' },
  resources: { name: 'first', uri: 'test://first' },
  tasks: {
    taskId: 'first',
    status: 'working',
    ttl: null,
    createdAt: '2026-01-01T00:00:00Z',
    lastUpdatedAt: '2026-01-01T00:00:00Z',
  },
};

function pages(key: Key): Page[] {
  return [
    {
      [key]: [items[key]],
      nextCursor: 'second',
      _meta: { first: true, overlap: 'first', nested: { first: true } },
      firstField: true,
      overlap: { first: true },
      ttlMs: 60_000,
    },
    {
      [key]: [],
      nextCursor: 'third',
      _meta: { middle: true, overlap: 'middle' },
      middleField: true,
    },
    {
      [key]: [{ ...items[key], name: 'last', uri: 'test://last', taskId: 'last' }],
      _meta: { last: true, overlap: 'last', nested: { last: true } },
      lastField: true,
      overlap: { last: true },
      ttlMs: 30_000,
    },
  ];
}

/** A fetch-level fixture: the actual pinned SDK performs decoding, pagination and caching. */
async function fixture(modern = false) {
  const requests: { method: string; params?: Record<string, unknown>; headers: Headers }[] = [];
  const results = new Map<Key, Page[]>();
  let failPage = false;
  let stallPage = false;
  let invalidOutput = false;
  let abortedPosts = 0;
  const version = modern ? '2026-07-28' : '2025-11-25';
  const capabilities = { tools: {}, prompts: {}, resources: {}, tasks: { list: {} } };
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), {
    fetch: async (_url, init) => {
      if (init?.method === 'GET') return new Response(null, { status: 405 });
      if (init?.method === 'DELETE') return new Response(null, { status: 200 });
      const message = JSON.parse(init?.body as string);
      requests.push({ ...message, headers: new Headers(init?.headers) });
      if (message.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      let error: unknown;
      if (message.method === 'initialize') {
        result = {
          protocolVersion: version,
          capabilities,
          serverInfo: { name: 'pages', version: '1' },
        };
      } else if (message.method === 'server/discover') {
        result = {
          supportedVersions: [version],
          capabilities: { tools: {}, prompts: {}, resources: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'pages', version: '1' } },
        };
      } else if (message.method === 'tools/call') {
        result = {
          resultType: 'complete',
          content: [],
          structuredContent: { value: invalidOutput ? 3 : 'ok' },
        };
      } else {
        const key = message.method.split('/')[0] as Key;
        const index =
          message.params?.cursor === 'second' ? 1 : message.params?.cursor === 'third' ? 2 : 0;
        if (index === 1 && stallPage) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => {
                abortedPosts++;
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true }
            );
          });
        }
        if (index === 1 && failPage) error = { code: -32603, message: 'second page failed' };
        else
          result = {
            ...(modern && { resultType: 'complete', ttlMs: 60_000, cacheScope: 'private' }),
            ...(results.get(key)?.[index] ?? { [key]: [] }),
          };
      }
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, ...(error ? { error } : { result }) }),
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );
    },
  });
  const client = new McpClient(
    { name: 'list-results-test', version: '1' },
    { protocolVersion: version }
  );
  await client.connect(transport);
  return {
    client,
    requests,
    results,
    fail: (value: boolean) => {
      failPage = value;
    },
    stall: (value: boolean) => {
      stallPage = value;
    },
    invalidOutput: () => {
      invalidOutput = true;
    },
    abortedPosts: () => abortedPosts,
  };
}

async function read(client: McpClient, key: Key) {
  switch (key) {
    case 'tools':
      return client.listAllTools();
    case 'prompts':
      return fetchAllPagesResult((cursor) => client.listPrompts(cursor), 'prompts');
    case 'resources':
      return fetchAllPagesResult((cursor) => client.listResources(cursor), 'resources');
    case 'tasks':
      return fetchAllPagesResult((cursor) => client.listTasks(cursor), 'tasks');
  }
}

describe.each([false, true])('SDK protocol pages (modern=%s)', (modern) => {
  const keys: Key[] = modern
    ? ['tools', 'prompts', 'resources']
    : ['tools', 'prompts', 'resources', 'tasks'];
  it.each(keys)('merges all %s fields in order and retains cached metadata', async (key) => {
    const f = await fixture(modern);
    f.results.set(key, pages(key));
    try {
      const result = await read(f.client, key);
      expect(result[key]).toHaveLength(2);
      expect(result).toMatchObject({
        _meta: { first: true, middle: true, last: true, overlap: 'last', nested: { last: true } },
        firstField: true,
        middleField: true,
        lastField: true,
        overlap: { last: true },
        ttlMs: 30_000,
      });
      expect(result._meta).not.toHaveProperty('nested.first');
      expect(result).not.toHaveProperty('nextCursor');
      const calls = () => f.requests.filter((r) => r.method === `${key}/list`);
      expect(calls().map((r) => r.params?.cursor)).toEqual([undefined, 'second', 'third']);
      if (modern) {
        for (const r of calls()) {
          expect(r.headers.get('Mcp-Method')).toBe(`${key}/list`);
          expect(r.headers.get('MCP-Protocol-Version')).toBe('2026-07-28');
        }
      }
      if (key !== 'tasks') {
        // Read the SDK cache, not just mcpc's outer tools cache.
        const cached = key === 'tools' ? await f.client.listTools() : await read(f.client, key);
        expect(cached).toEqual(result);
        expect(calls()).toHaveLength(3);
      }
      if (key === 'tools') {
        expect(await f.client.listAllTools()).toEqual(result);
        expect(await f.client.listAllTools({ refreshCache: true })).toEqual(result);
        expect(calls()).toHaveLength(6);
      }
    } finally {
      await f.client.close();
    }
  });

  it.each(keys)('returns an empty %s result without manufacturing _meta', async (key) => {
    const f = await fixture(modern);
    try {
      const result = await read(f.client, key);
      expect(result[key]).toEqual([]);
      expect(result).not.toHaveProperty('_meta');
      expect(result).not.toHaveProperty('nextCursor');
      if (!modern) expect(result).toEqual({ [key]: [] });
    } finally {
      await f.client.close();
    }
  });

  it.each(keys)('does not cache partial %s results after a later-page error', async (key) => {
    const f = await fixture(modern);
    f.results.set(key, pages(key));
    f.fail(true);
    try {
      await expect(read(f.client, key)).rejects.toThrow('second page failed');
      if (key === 'tools') expect(f.client.getCachedTools()).toBeNull();
      f.fail(false);
      expect(await read(f.client, key)).toHaveProperty('lastField', true);
      expect(
        f.requests.filter((r) => r.method === `${key}/list`).map((r) => r.params?.cursor)
      ).toEqual([undefined, 'second', undefined, 'second', 'third']);
    } finally {
      await f.client.close();
    }
  });

  it.each(keys)('cancels a timed-out %s page and retries from page one', async (key) => {
    const f = await fixture(modern);
    f.results.set(key, pages(key));
    f.stall(true);
    f.client.setRequestTimeout(30);
    try {
      await expect(read(f.client, key)).rejects.toThrow(/timed out|timeout/i);
      // The SDK uses HTTP abort in the modern era and a notification in the legacy era.
      if (modern) expect(f.abortedPosts()).toBe(1);
      else expect(f.requests.some((r) => r.method === 'notifications/cancelled')).toBe(true);
      f.stall(false);
      f.client.resetRequestTimeout();
      expect(await read(f.client, key)).toHaveProperty('lastField', true);
    } finally {
      await f.client.close();
    }
  });

  it('isolates metadata in simultaneous list walks', async () => {
    const f = await fixture(modern);
    for (const key of ['tools', 'prompts', 'resources'] as const) {
      f.results.set(
        key,
        pages(key).map((page) => ({
          ...page,
          source: key,
          _meta: { ...(page._meta as object), source: key },
        }))
      );
    }
    try {
      const results = await Promise.all(
        ['tools', 'prompts', 'resources'].map((key) => read(f.client, key as Key))
      );
      for (const [index, key] of ['tools', 'prompts', 'resources'].entries()) {
        expect(results[index]).toHaveProperty('source', key);
        expect(results[index]?._meta).toHaveProperty('source', key);
      }
    } finally {
      await f.client.close();
    }
  });
});

it('keeps modern tool filtering, later-page output validation and header mirroring', async () => {
  const f = await fixture(true);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.results.set('tools', [
    { tools: [items.tools], nextCursor: 'second', first: true },
    {
      tools: [
        {
          name: 'invalid-header',
          inputSchema: {
            type: 'object',
            properties: { route: { type: 'string', 'x-mcp-header': '' } },
          },
        },
        {
          name: 'later',
          inputSchema: {
            type: 'object',
            properties: { route: { type: 'string', 'x-mcp-header': 'Route' } },
          },
          outputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      ],
      last: true,
    },
  ]);
  try {
    const result = await f.client.listAllTools();
    expect(result.tools.map((t) => t.name)).toEqual(['first', 'later']);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('invalid-header'));
    await f.client.callTool('later', { route: 'west' });
    const call = f.requests.find((r) => r.method === 'tools/call')!;
    expect(call.headers.get('Mcp-Name')).toBe('later');
    expect(call.headers.get('Mcp-Param-Route')).toBe('west');
    expect(call.params?._meta).not.toHaveProperty('onListPage');
    f.invalidOutput();
    await expect(f.client.callTool('later', { route: 'west' })).rejects.toThrow(/output|schema/i);
  } finally {
    warning.mockRestore();
    await f.client.close();
  }
});
