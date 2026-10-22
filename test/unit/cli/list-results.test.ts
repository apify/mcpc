/** Command-level coverage for the MCP list result JSON envelopes. */

vi.mock('../../../src/cli/helpers.js', () => ({
  withMcpClient: vi.fn(),
}));

import { stripVTControlCharacters } from 'node:util';
import { listTools } from '../../../src/cli/commands/tools.js';
import { listPrompts } from '../../../src/cli/commands/prompts.js';
import { listResources } from '../../../src/cli/commands/resources.js';
import { listTasks } from '../../../src/cli/commands/tasks.js';
import { withMcpClient } from '../../../src/cli/helpers.js';
import type { IMcpClient } from '../../../src/lib/types.js';

const tool = {
  name: 'echo',
  description: 'Echo the message',
  inputSchema: {
    type: 'object' as const,
    properties: { message: { type: 'string' } },
    required: ['message'],
  },
};
const prompt = {
  name: 'greeting',
  description: 'Create a greeting',
  arguments: [{ name: 'name', required: true }],
};
const resource = {
  uri: 'test://hello',
  name: 'Hello Resource',
  mimeType: 'text/plain',
  description: 'A greeting resource',
};
const task = {
  taskId: 'task-1',
  status: 'working' as const,
  createdAt: '2026-01-01T00:00:00Z',
  lastUpdatedAt: '2026-01-01T00:00:00Z',
  ttl: null,
};

const paginatedCommands = [
  {
    command: 'prompts-list',
    key: 'prompts',
    method: 'listPrompts',
    item: prompt,
    run: listPrompts,
  },
  {
    command: 'resources-list',
    key: 'resources',
    method: 'listResources',
    item: resource,
    run: listResources,
  },
  { command: 'tasks-list', key: 'tasks', method: 'listTasks', item: task, run: listTasks },
] as const;

const commands = [
  { command: 'tools-list', key: 'tools', method: 'listAllTools', item: tool, run: listTools },
  ...paginatedCommands,
] as const;

function useClient(client: Partial<IMcpClient>): void {
  vi.mocked(withMcpClient).mockImplementation(async (_target, _options, callback) =>
    callback(client as never, {})
  );
}

function serverDetails(protocolVersion = '2025-11-25') {
  return vi.fn().mockResolvedValue({ protocolVersion });
}

function output(): string {
  return stripVTControlCharacters(
    vi
      .mocked(console.log)
      .mock.calls.map(([value]) => String(value))
      .join('\n')
  );
}

beforeEach(() => {
  vi.mocked(withMcpClient).mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(paginatedCommands)('$command JSON pagination', ({ key, method, item, run }) => {
  it('merges actual command pages in order and removes the consumed cursor', async () => {
    const secondItem = { ...item, name: 'second', uri: 'test://second', taskId: 'task-2' };
    const pages = [
      {
        [key]: [item],
        nextCursor: 'page-2',
        _meta: { first: true, shared: 'first', nested: { first: true } },
        firstField: true,
        sharedField: { first: true },
      },
      {
        [key]: [],
        nextCursor: 'page-3',
        _meta: { second: true, shared: 'second', nested: { second: true } },
        sharedField: { second: true },
      },
      {
        [key]: [secondItem],
        _meta: { last: true, shared: 'last' },
        lastField: true,
      },
    ];
    const list = vi
      .fn()
      .mockResolvedValueOnce(pages[0])
      .mockResolvedValueOnce(pages[1])
      .mockResolvedValueOnce(pages[2]);
    useClient({ [method]: list, getServerDetails: serverDetails() });

    await run('@s', { outputMode: 'json', maxChars: 1 });

    expect(list.mock.calls).toEqual([[undefined], ['page-2'], ['page-3']]);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output())).toEqual({
      [key]: [item, secondItem],
      _meta: {
        first: true,
        second: true,
        last: true,
        shared: 'last',
        nested: { second: true },
      },
      firstField: true,
      sharedField: { second: true },
      lastField: true,
    });
  });

  it.each([new Error('later page failed'), new DOMException('cancelled', 'AbortError')])(
    'prints no partial result when a later page rejects with %s',
    async (error) => {
      const list = vi
        .fn()
        .mockResolvedValueOnce({ [key]: [item], nextCursor: 'page-2' })
        .mockRejectedValueOnce(error);
      useClient({ [method]: list, getServerDetails: serverDetails() });

      await expect(run('@s', { outputMode: 'json' })).rejects.toBe(error);

      expect(list.mock.calls).toEqual([[undefined], ['page-2']]);
      expect(console.log).not.toHaveBeenCalled();
    }
  );
});

describe('tools-list JSON', () => {
  it('prints the complete cached result without extracting or wrapping its tools', async () => {
    const result = {
      tools: [tool],
      _meta: { firstPage: true, lastPage: true, shared: 'last' },
      extensionField: { value: 'retained' },
    };
    const listAllTools = vi.fn().mockResolvedValue(result);
    useClient({ listAllTools });

    await listTools('@s', { outputMode: 'json', full: true, maxChars: 1 });

    expect(listAllTools).toHaveBeenCalledExactlyOnceWith({ refreshCache: true });
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output())).toEqual(result);
  });

  it.each([new Error('listing failed'), new DOMException('cancelled', 'AbortError')])(
    'prints no result when listing rejects with %s',
    async (error) => {
      useClient({ listAllTools: vi.fn().mockRejectedValue(error) });

      await expect(listTools('@s', { outputMode: 'json' })).rejects.toBe(error);

      expect(console.log).not.toHaveBeenCalled();
    }
  );
});

describe.each(commands)('$command empty JSON result', ({ key, method, run }) => {
  it('retains the named empty array inside one result object', async () => {
    useClient({
      [method]: vi.fn().mockResolvedValue({ [key]: [] }),
      getServerDetails: serverDetails(),
    });

    await run('@s', { outputMode: 'json' });

    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output())).toEqual({ [key]: [] });
  });
});

describe('human list output', () => {
  it('keeps the compact tools list and its session-specific hints', async () => {
    useClient({ listAllTools: vi.fn().mockResolvedValue({ tools: [tool], hidden: 'metadata' }) });

    await listTools('@s', { outputMode: 'human' });

    expect(output()).toContain('Tools (1):');
    expect(output()).toContain('echo (message:str)');
    expect(output()).toContain('mcpc @s tools-get <name>');
    expect(output()).not.toContain('Echo the message');
    expect(output()).not.toContain('metadata');
  });

  it('keeps --full tool details and schema', async () => {
    useClient({ listAllTools: vi.fn().mockResolvedValue({ tools: [tool], hidden: 'metadata' }) });

    await listTools('@s', { outputMode: 'human', full: true });

    expect(output()).toContain('Tools (1):');
    expect(output()).toContain('---');
    expect(output()).toContain('Tool: `echo`');
    expect(output()).toContain('Echo the message');
    expect(output()).toContain('Input:');
    expect(output()).toContain('`message`: string [required]');
    expect(output()).not.toContain('metadata');
  });

  it('keeps prompts and their argument details across pages', async () => {
    useClient({
      listPrompts: vi
        .fn()
        .mockResolvedValueOnce({ prompts: [], nextCursor: 'page-2', hidden: 'metadata' })
        .mockResolvedValueOnce({ prompts: [prompt] }),
    });

    await listPrompts('@s', { outputMode: 'human' });

    expect(output()).toContain('Prompts (1):');
    expect(output()).toContain('Prompt: `greeting`');
    expect(output()).toContain('Arguments:');
    expect(output()).toContain('[required]');
    expect(output()).toContain('Create a greeting');
    expect(output()).not.toContain('metadata');
  });

  it('keeps resources and their MIME type details across pages', async () => {
    useClient({
      listResources: vi
        .fn()
        .mockResolvedValueOnce({ resources: [], nextCursor: 'page-2', hidden: 'metadata' })
        .mockResolvedValueOnce({ resources: [resource] }),
    });

    await listResources('@s', { outputMode: 'human' });

    expect(output()).toContain('Resources (1):');
    expect(output()).toContain('Resource: `test://hello`');
    expect(output()).toContain('Hello Resource');
    expect(output()).toContain('MIME type: text/plain');
    expect(output()).not.toContain('metadata');
  });

  it.each([
    ['2025-11-25', 'No active tasks'],
    ['2026-07-28', 'No tasks started from this session'],
  ])('keeps the %s empty task state', async (version, message) => {
    useClient({
      listTasks: vi.fn().mockResolvedValue({ tasks: [] }),
      getServerDetails: serverDetails(version),
    });

    await listTasks('@s', { outputMode: 'human' });

    expect(output()).toContain(message);
    expect(output()).toContain('mcpc @s tools-call <name> [args] --task');
  });

  it.each(['2025-11-25', '2026-07-28'])(
    'keeps the %s task list, commands, and protocol-era note',
    async (version) => {
      useClient({
        listTasks: vi.fn().mockResolvedValue({ tasks: [task], hidden: 'metadata' }),
        getServerDetails: serverDetails(version),
      });

      await listTasks('@s', { outputMode: 'human' });

      expect(output()).toContain('task-1');
      expect(output()).toContain('working');
      expect(output()).toContain('mcpc @s tasks-get <taskId>');
      if (version === '2026-07-28') {
        expect(output()).toContain('Tasks started from this session (1):');
        expect(output()).toContain('MCP 2026-07-28 servers keep no task listing');
      } else {
        expect(output()).toContain('Tasks (1):');
        expect(output()).not.toContain('servers keep no task listing');
      }
      expect(output()).not.toContain('metadata');
    }
  );
});
