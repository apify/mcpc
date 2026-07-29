/**
 * Unit tests for the protocol-era behavior of McpClient.
 *
 * The interesting logic here is era-dependent and hard to reach from e2e (which only
 * covers the happy paths against the two test servers): the 2026-07-28
 * `subscriptions/listen` mechanics and their rollback/re-listen branches, connection
 * mode derivation, the era fallback used by resumed sessions, the stateless tools-cache
 * expiry, and the guards that reject removed protocol methods.
 *
 * The SDK Client is stubbed so each branch can be driven directly.
 */

import { vi } from 'vitest';
import { SdkHttpError, SdkErrorCode } from '@modelcontextprotocol/client';
import { McpClient, isExpectedProbeRejection } from '../../../src/core/mcp-client.js';
import { ServerError } from '../../../src/lib/errors.js';
import { Logger } from '../../../src/lib/logger.js';

vi.mock('@modelcontextprotocol/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/client')>();
  // Must be a `function` (not an arrow) — McpClient calls it with `new`.
  return {
    ...actual,
    Client: vi.fn(function () {
      return stubSdkClient;
    }),
  };
});

/** A `subscriptions/listen` stream stub whose `closed` promise the test resolves. */
interface StubSubscription {
  honoredFilter: { resourceSubscriptions?: string[] };
  closed: Promise<string>;
  close: ReturnType<typeof vi.fn>;
  drop: (reason: string) => void;
}

function makeSubscription(honoredUris?: string[]): StubSubscription {
  let drop!: (reason: string) => void;
  const closed = new Promise<string>((resolve) => {
    drop = resolve;
  });
  return {
    honoredFilter: honoredUris ? { resourceSubscriptions: honoredUris } : {},
    closed,
    close: vi.fn().mockResolvedValue(undefined),
    drop,
  };
}

/** The stub returned by the mocked SDK `Client` constructor; re-created per test. */
let stubSdkClient: Record<string, ReturnType<typeof vi.fn> | unknown>;

/** Mutable state the stub reports back to McpClient. */
let era: 'modern' | 'legacy' | undefined;
let negotiatedVersion: string | undefined;
let listenQueue: StubSubscription[];
let listenCalls: unknown[];
/** The `server/discover` result the stub reports; undefined on legacy connections. */
let discoverResult: Record<string, unknown> | undefined;

function resetSdkStub(): void {
  era = 'legacy';
  negotiatedVersion = '2025-11-25';
  listenQueue = [];
  listenCalls = [];
  discoverResult = undefined;
  stubSdkClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getServerVersion: vi.fn().mockReturnValue({ name: 'stub', version: '1.0.0' }),
    getServerCapabilities: vi.fn().mockReturnValue({}),
    getInstructions: vi.fn().mockReturnValue(undefined),
    getNegotiatedProtocolVersion: vi.fn(() => negotiatedVersion),
    getProtocolEra: vi.fn(() => era),
    getDiscoverResult: vi.fn(() => discoverResult),
    ping: vi.fn().mockResolvedValue(undefined),
    discover: vi.fn().mockResolvedValue({}),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    setLoggingLevel: vi.fn().mockResolvedValue(undefined),
    subscribeResource: vi.fn().mockResolvedValue(undefined),
    unsubscribeResource: vi.fn().mockResolvedValue(undefined),
    listen: vi.fn(async (filter: unknown) => {
      listenCalls.push(filter);
      const next = listenQueue.shift();
      if (!next) throw new Error('no queued listen result');
      return next;
    }),
    request: vi.fn().mockResolvedValue({}),
    autoOpenedSubscription: undefined,
    onerror: undefined,
  };
}

/** Transport stubs: only `terminateSession` distinguishes HTTP from stdio. */
function httpTransport(sessionId?: string): Record<string, unknown> {
  return { terminateSession: vi.fn().mockResolvedValue(undefined), sessionId };
}
function stdioTransport(): Record<string, unknown> {
  return {};
}

/** Connect a client to the given transport, in the given era. */
async function connectClient(options: {
  transport?: Record<string, unknown>;
  era?: 'modern' | 'legacy';
  version?: string;
}): Promise<McpClient> {
  era = options.era ?? 'legacy';
  negotiatedVersion = options.version ?? (era === 'modern' ? '2026-07-28' : '2025-11-25');
  const client = new McpClient({ name: 'test', version: '0.0.0' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await client.connect((options.transport ?? httpTransport('sess-1')) as any);
  return client;
}

beforeEach(() => {
  resetSdkStub();
  vi.clearAllMocks();
});

describe('connection mode', () => {
  it('reports stateful for an HTTP transport that was given a session id', async () => {
    const client = await connectClient({ transport: httpTransport('sess-1') });
    expect((await client.getServerDetails()).connectionMode).toBe('stateful');
  });

  it('reports stateless for an HTTP transport with no session id', async () => {
    const client = await connectClient({ transport: httpTransport(undefined), era: 'modern' });
    expect((await client.getServerDetails()).connectionMode).toBe('stateless');
  });

  it('reports stateful for stdio, which is always a local process', async () => {
    const client = await connectClient({ transport: stdioTransport(), era: 'modern' });
    expect((await client.getServerDetails()).connectionMode).toBe('stateful');
  });

  it('reports unknown before connecting', async () => {
    const client = new McpClient({ name: 'test', version: '0.0.0' });
    expect((await client.getServerDetails()).connectionMode).toBe('unknown');
  });
});

describe('transport kind', () => {
  it('reports streamable-http for an HTTP transport', async () => {
    const client = await connectClient({ transport: httpTransport('sess-1') });
    expect((await client.getServerDetails()).transport).toBe('streamable-http');
  });

  it('reports stdio for a stdio transport', async () => {
    const client = await connectClient({ transport: stdioTransport(), era: 'modern' });
    expect((await client.getServerDetails()).transport).toBe('stdio');
  });

  it('reports nothing before connecting', async () => {
    const client = new McpClient({ name: 'test', version: '0.0.0' });
    expect((await client.getServerDetails()).transport).toBeUndefined();
  });
});

describe('server details', () => {
  it('reports the discover-only fields on a modern connection', async () => {
    discoverResult = {
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities: {},
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'stub', version: '1.0.0' } },
    };
    const client = await connectClient({ era: 'modern' });

    const details = await client.getServerDetails();
    expect(details.protocolVersion).toBe('2026-07-28');
    expect(details.supportedVersions).toEqual(['2026-07-28', '2025-11-25']);
    expect(details._meta).toEqual({
      'io.modelcontextprotocol/serverInfo': { name: 'stub', version: '1.0.0' },
    });
  });

  it('takes the server identity from the discover result, not the connect-time accessor', async () => {
    // `ping` re-runs server/discover on a modern connection, which refreshes the discover
    // result but not the SDK's connect-time accessor — so `serverInfo` and `_meta` would
    // otherwise disagree after a server redeploy.
    discoverResult = {
      supportedVersions: ['2026-07-28'],
      capabilities: {},
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'stub', version: '2.0.0' } },
    };
    const client = await connectClient({ era: 'modern' });

    const details = await client.getServerDetails();
    expect(details.serverInfo).toEqual({ name: 'stub', version: '2.0.0' });
  });

  it('falls back to the accessor when a modern server sends no identity', async () => {
    // Sending it is only a SHOULD, so a modern connect can leave the identity unset.
    discoverResult = { supportedVersions: ['2026-07-28'], capabilities: {} };
    const client = await connectClient({ era: 'modern' });

    const details = await client.getServerDetails();
    expect(details.serverInfo).toEqual({ name: 'stub', version: '1.0.0' });
  });

  it('omits them on a legacy connection, which has no discover result', async () => {
    const client = await connectClient({ era: 'legacy' });

    const details = await client.getServerDetails();
    expect(details.protocolVersion).toBe('2025-11-25');
    expect(details.supportedVersions).toBeUndefined();
    expect(details._meta).toBeUndefined();
  });
});

describe('protocol era', () => {
  it('uses the era reported by the SDK client', async () => {
    const client = await connectClient({ era: 'modern' });
    expect(client.getProtocolEra()).toBe('modern');
  });

  it('derives the era from the restored version when the SDK does not know it', async () => {
    // A resumed HTTP session skips the handshake, so the SDK client reports no era —
    // the negotiated version restored from sessions.json is the only signal left.
    const client = await connectClient({ era: 'modern', version: '2026-07-28' });
    era = undefined;
    expect(client.getProtocolEra()).toBe('modern');
  });

  it('derives the legacy era from a restored 2025-era version', async () => {
    const client = await connectClient({ era: 'legacy', version: '2025-11-25' });
    era = undefined;
    expect(client.getProtocolEra()).toBe('legacy');
  });

  it('reports no era when neither the SDK nor a version is known', async () => {
    era = undefined;
    negotiatedVersion = undefined;
    const client = new McpClient({ name: 'test', version: '0.0.0' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.connect(httpTransport() as any);
    expect(client.getProtocolEra()).toBeUndefined();
  });
});

describe('removed protocol methods are rejected per era', () => {
  it('rejects logging-set-level on a modern connection without calling the SDK', async () => {
    const client = await connectClient({ era: 'modern' });
    await expect(client.setLoggingLevel('debug')).rejects.toThrow(/logging\/setLevel was removed/);
    expect(stubSdkClient.setLoggingLevel).not.toHaveBeenCalled();
  });

  it('does not wrap the era-gate message in a "Failed to ..." prefix', async () => {
    // The CLI appends ". For details, run: ..." to the message, so a nested wrapper
    // (and a trailing period) would render as "Failed to list tasks: Tasks are not ...25.."
    const client = await connectClient({ era: 'modern' });
    await expect(client.listTasks()).rejects.toThrow(/^Tasks are not available/);
    for (const call of [
      client.getTask('t1'),
      client.getTaskResult('t1'),
      client.cancelTask('t1'),
    ]) {
      await expect(call).rejects.toThrow(/^Tasks are not available/);
    }
    expect(stubSdkClient.request).not.toHaveBeenCalled();
  });

  it('does not end era-gate messages with a period', async () => {
    const client = await connectClient({ era: 'modern' });
    for (const call of [client.setLoggingLevel('debug'), client.listTasks()]) {
      await expect(call).rejects.toThrow(
        expect.objectContaining({ message: expect.not.stringMatching(/\.$/) })
      );
    }
  });

  it('allows logging-set-level and task requests on a legacy connection', async () => {
    const client = await connectClient({ era: 'legacy' });
    await client.setLoggingLevel('debug');
    expect(stubSdkClient.setLoggingLevel).toHaveBeenCalledWith('debug', expect.anything());
    stubSdkClient.request = vi.fn().mockResolvedValue({ tasks: [] });
    await expect(client.listTasks()).resolves.toEqual({ tasks: [] });
  });

  it('never advertises task-augmented tool calls on a modern connection', async () => {
    stubSdkClient.getServerCapabilities = vi
      .fn()
      .mockReturnValue({ tasks: { requests: { tools: { call: {} } } } });
    const legacy = await connectClient({ era: 'legacy' });
    expect(legacy.supportsTasksForToolCall()).toBe(true);
    const modern = await connectClient({ era: 'modern' });
    expect(modern.supportsTasksForToolCall()).toBe(false);
  });
});

describe('ping', () => {
  it('sends ping on a legacy connection', async () => {
    const client = await connectClient({ era: 'legacy' });
    await client.ping();
    expect(stubSdkClient.ping).toHaveBeenCalled();
    expect(stubSdkClient.discover).not.toHaveBeenCalled();
  });

  it('sends server/discover on a modern connection, where ping was removed', async () => {
    const client = await connectClient({ era: 'modern' });
    await client.ping();
    expect(stubSdkClient.discover).toHaveBeenCalled();
    expect(stubSdkClient.ping).not.toHaveBeenCalled();
  });
});

describe('resource subscriptions (legacy era)', () => {
  it('issues resources/subscribe and resources/unsubscribe', async () => {
    const client = await connectClient({ era: 'legacy' });
    await client.subscribeResource('res://a');
    expect(stubSdkClient.subscribeResource).toHaveBeenCalledWith(
      { uri: 'res://a' },
      expect.anything()
    );
    await client.unsubscribeResource('res://a');
    expect(stubSdkClient.unsubscribeResource).toHaveBeenCalledWith(
      { uri: 'res://a' },
      expect.anything()
    );
    expect(stubSdkClient.listen).not.toHaveBeenCalled();
  });
});

describe('resource subscriptions (modern era, subscriptions/listen)', () => {
  it('opens one listen stream carrying every subscribed URI', async () => {
    const client = await connectClient({ era: 'modern' });
    listenQueue = [makeSubscription(['res://a'])];
    await client.subscribeResource('res://a');
    expect(listenCalls).toEqual([{ resourceSubscriptions: ['res://a'] }]);

    // A second subscribe re-opens the stream with both URIs, closing the first.
    const first = listenQueue;
    void first;
    listenQueue = [makeSubscription(['res://a', 'res://b'])];
    await client.subscribeResource('res://b');
    expect(listenCalls[1]).toEqual({ resourceSubscriptions: ['res://a', 'res://b'] });
    expect(stubSdkClient.subscribeResource).not.toHaveBeenCalled();
  });

  it('fails loudly when the server does not honor a requested URI', async () => {
    const client = await connectClient({ era: 'modern' });
    // Acknowledgment omits the URI — the 2026-07-28 signal for "not supported",
    // since the resources.subscribe capability flag no longer exists.
    const unhonored = makeSubscription([]);
    listenQueue = [unhonored];
    await expect(client.subscribeResource('res://a')).rejects.toThrow(ServerError);
    expect(unhonored.close).toHaveBeenCalled();
  });

  it('rolls the rejected URI back out of the subscription set', async () => {
    const client = await connectClient({ era: 'modern' });
    listenQueue = [makeSubscription(['res://a'])];
    await client.subscribeResource('res://a');

    // res://b is refused: the rollback must restore a stream for res://a alone,
    // and must not keep asking for res://b afterwards.
    listenQueue = [makeSubscription(['res://a']), makeSubscription(['res://a'])];
    await expect(client.subscribeResource('res://b')).rejects.toThrow(
      /does not support subscriptions for res:\/\/b/
    );
    expect(listenCalls[listenCalls.length - 1]).toEqual({ resourceSubscriptions: ['res://a'] });
  });

  it('closes the stream once the last URI is unsubscribed', async () => {
    const client = await connectClient({ era: 'modern' });
    const subscription = makeSubscription(['res://a']);
    listenQueue = [subscription];
    await client.subscribeResource('res://a');

    await client.unsubscribeResource('res://a');
    expect(subscription.close).toHaveBeenCalled();
    // Nothing left to listen for, so no new stream was opened.
    expect(listenCalls).toHaveLength(1);
    expect(stubSdkClient.unsubscribeResource).not.toHaveBeenCalled();
  });

  it('re-opens the stream after an unexpected remote drop', async () => {
    vi.useFakeTimers();
    try {
      const client = await connectClient({ era: 'modern' });
      const subscription = makeSubscription(['res://a']);
      listenQueue = [subscription];
      await client.subscribeResource('res://a');

      listenQueue = [makeSubscription(['res://a'])];
      subscription.drop('remote');
      await vi.advanceTimersByTimeAsync(1_100);

      expect(listenCalls).toHaveLength(2);
      expect(listenCalls[1]).toEqual({ resourceSubscriptions: ['res://a'] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-open after a deliberate local close', async () => {
    vi.useFakeTimers();
    try {
      const client = await connectClient({ era: 'modern' });
      const subscription = makeSubscription(['res://a']);
      listenQueue = [subscription];
      await client.subscribeResource('res://a');

      subscription.drop('local');
      await vi.advanceTimersByTimeAsync(5_000);

      expect(listenCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps retrying with backoff until the re-listen succeeds', async () => {
    vi.useFakeTimers();
    try {
      const client = await connectClient({ era: 'modern' });
      const subscription = makeSubscription(['res://a']);
      listenQueue = [subscription];
      await client.subscribeResource('res://a');

      // First two re-listens fail (empty queue throws), the third succeeds.
      subscription.drop('remote');
      await vi.advanceTimersByTimeAsync(1_100); // attempt 1 fails
      expect(listenCalls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(2_100); // attempt 2 fails
      expect(listenCalls).toHaveLength(3);

      listenQueue = [makeSubscription(['res://a'])];
      await vi.advanceTimersByTimeAsync(4_100); // attempt 3 succeeds
      expect(listenCalls).toHaveLength(4);

      // No further attempts once re-established.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(listenCalls).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-opens the auto-opened listChanged stream after a remote drop', async () => {
    vi.useFakeTimers();
    try {
      const autoOpened = makeSubscription();
      stubSdkClient.autoOpenedSubscription = autoOpened;
      await connectClient({ era: 'modern' });

      listenQueue = [makeSubscription()];
      autoOpened.drop('remote');
      await vi.advanceTimersByTimeAsync(1_100);

      expect(listenCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('tools cache', () => {
  it('caches indefinitely on a stateful connection', async () => {
    const client = await connectClient({ transport: httpTransport('sess-1'), era: 'legacy' });
    stubSdkClient.listTools = vi.fn().mockResolvedValue({ tools: [{ name: 'a' }] });

    await client.listAllTools();
    await client.listAllTools();
    expect(stubSdkClient.listTools).toHaveBeenCalledTimes(1);

    // Even far in the future — stateful connections rely on list_changed pushes.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
    await client.listAllTools();
    expect(stubSdkClient.listTools).toHaveBeenCalledTimes(1);
    vi.mocked(Date.now).mockRestore();
  });

  it('expires the cache on a stateless connection, which cannot push list_changed', async () => {
    const client = await connectClient({ transport: httpTransport(undefined), era: 'modern' });
    stubSdkClient.listTools = vi.fn().mockResolvedValue({ tools: [{ name: 'a' }] });

    const start = Date.now();
    await client.listAllTools();
    expect(stubSdkClient.listTools).toHaveBeenCalledTimes(1);

    vi.spyOn(Date, 'now').mockReturnValue(start + 30_000);
    await client.listAllTools();
    expect(stubSdkClient.listTools).toHaveBeenCalledTimes(1);

    vi.mocked(Date.now).mockReturnValue(start + 61_000);
    await client.listAllTools();
    expect(stubSdkClient.listTools).toHaveBeenCalledTimes(2);
    vi.mocked(Date.now).mockRestore();
  });

  it('honors a server-sent ttlMs cache hint over the stateless fallback', async () => {
    const client = await connectClient({ transport: httpTransport(undefined), era: 'modern' });
    stubSdkClient.listTools = vi.fn().mockResolvedValue({ tools: [{ name: 'a' }], ttlMs: 5_000 });

    const start = Date.now();
    await client.listAllTools();
    expect(stubSdkClient.listTools).toHaveBeenCalledTimes(1);

    // Still fresh per the hint, even though the stateless fallback would also hold here.
    vi.spyOn(Date, 'now').mockReturnValue(start + 4_000);
    await client.listAllTools();
    expect(stubSdkClient.listTools).toHaveBeenCalledTimes(1);

    // Expired per the hint, long before the 60s stateless fallback would have.
    vi.mocked(Date.now).mockReturnValue(start + 6_000);
    await client.listAllTools();
    expect(stubSdkClient.listTools).toHaveBeenCalledTimes(2);
    vi.mocked(Date.now).mockRestore();
  });

  it('treats ttlMs 0 as immediately stale on a stateful connection', async () => {
    const client = await connectClient({ transport: httpTransport('sess-1'), era: 'modern' });
    stubSdkClient.listTools = vi.fn().mockResolvedValue({ tools: [{ name: 'a' }], ttlMs: 0 });

    await client.listAllTools();
    await client.listAllTools();
    expect(stubSdkClient.listTools).toHaveBeenCalledTimes(2);
  });

  it('bypasses the SDK response cache when refreshing', async () => {
    const client = await connectClient({ era: 'legacy' });
    stubSdkClient.listTools = vi.fn().mockResolvedValue({ tools: [{ name: 'a' }] });

    await client.listAllTools();
    expect(stubSdkClient.listTools).toHaveBeenLastCalledWith(
      { cursor: undefined },
      expect.not.objectContaining({ cacheMode: expect.anything() })
    );

    await client.listAllTools({ refreshCache: true });
    expect(stubSdkClient.listTools).toHaveBeenLastCalledWith(
      { cursor: undefined },
      expect.objectContaining({ cacheMode: 'refresh' })
    );
  });

  it('refetches on an explicit refresh and after invalidation', async () => {
    const client = await connectClient({ era: 'legacy' });
    stubSdkClient.listTools = vi.fn().mockResolvedValue({ tools: [{ name: 'a' }] });

    await client.listAllTools();
    expect(client.getCachedTools()).toEqual([{ name: 'a' }]);

    await client.listAllTools({ refreshCache: true });
    expect(stubSdkClient.listTools).toHaveBeenCalledTimes(2);

    client.invalidateToolsCache();
    expect(client.getCachedTools()).toBeNull();
    await client.listAllTools();
    expect(stubSdkClient.listTools).toHaveBeenCalledTimes(3);
  });
});

describe('close', () => {
  it('tears down the listen stream before terminating the session', async () => {
    const client = await connectClient({ era: 'modern' });
    const subscription = makeSubscription(['res://a']);
    listenQueue = [subscription];
    await client.subscribeResource('res://a');

    await client.close();
    expect(subscription.close).toHaveBeenCalled();
    expect(stubSdkClient.close).toHaveBeenCalled();
  });

  it('does not re-listen for a drop that arrives during close', async () => {
    vi.useFakeTimers();
    try {
      const client = await connectClient({ era: 'modern' });
      const subscription = makeSubscription(['res://a']);
      listenQueue = [subscription];
      await client.subscribeResource('res://a');

      const closing = client.close();
      subscription.drop('remote');
      await vi.advanceTimersByTimeAsync(5_000);
      await closing;

      expect(listenCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('server/discover probe rejection', () => {
  function probeRejection(status: number): SdkHttpError {
    return new SdkHttpError(
      SdkErrorCode.ClientHttpNotImplemented,
      'Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request"},"id":null}',
      { status, statusText: 'Bad Request' }
    );
  }

  function makeLoggerSpy() {
    const logger = new Logger('test');
    return {
      logger,
      debug: vi.spyOn(logger, 'debug').mockImplementation(() => {}),
      log: vi.spyOn(logger, 'log').mockImplementation(() => {}),
    };
  }

  it('recognizes non-auth 4xx probe answers as expected', () => {
    expect(isExpectedProbeRejection(probeRejection(400))).toBe(true);
    expect(isExpectedProbeRejection(probeRejection(404))).toBe(true);
    expect(isExpectedProbeRejection(probeRejection(405))).toBe(true);
  });

  it('keeps auth failures, server errors, and plain errors as real errors', () => {
    expect(isExpectedProbeRejection(probeRejection(401))).toBe(false);
    expect(isExpectedProbeRejection(probeRejection(403))).toBe(false);
    expect(isExpectedProbeRejection(probeRejection(500))).toBe(false);
    expect(isExpectedProbeRejection(new Error('boom'))).toBe(false);
  });

  it('logs a clean fallback line instead of a transport error during auto negotiation', async () => {
    const { logger, debug, log } = makeLoggerSpy();
    // Mimic the real timing: the probe is declined mid-connect, before hasConnected is set.
    (stubSdkClient.connect as ReturnType<typeof vi.fn>).mockImplementation(
      async (transport: { onerror?: (error: Error) => void }) => {
        transport.onerror?.(probeRejection(400));
      }
    );
    const client = new McpClient({ name: 'test', version: '0.0.0' }, { logger });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.connect(httpTransport('sess-1') as any);

    expect(debug).toHaveBeenCalledWith(expect.stringContaining('server/discover'));
    expect(log).not.toHaveBeenCalledWith(expect.anything(), 'Transport error:', expect.anything());
  });

  it('keeps the raw transport error when the protocol version is pinned', async () => {
    const { logger, log } = makeLoggerSpy();
    (stubSdkClient.connect as ReturnType<typeof vi.fn>).mockImplementation(
      async (transport: { onerror?: (error: Error) => void }) => {
        transport.onerror?.(probeRejection(400));
      }
    );
    const client = new McpClient(
      { name: 'test', version: '0.0.0' },
      { logger, protocolVersion: '2025-11-25' }
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.connect(httpTransport('sess-1') as any);

    expect(log).toHaveBeenCalledWith('debug', 'Transport error:', expect.any(SdkHttpError));
  });

  it('keeps logging 4xx transport errors once the connection is established', async () => {
    const { logger, log } = makeLoggerSpy();
    const transport = httpTransport('sess-1');
    const client = new McpClient({ name: 'test', version: '0.0.0' }, { logger });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.connect(transport as any);

    (transport.onerror as (error: Error) => void)(probeRejection(400));
    expect(log).toHaveBeenCalledWith('error', 'Transport error:', expect.any(SdkHttpError));
  });
});
