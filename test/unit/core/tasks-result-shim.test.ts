/**
 * Unit tests for the SDK response shim that carries the 2026-07-28 tasks extension
 * (src/core/tasks-result-shim.ts).
 *
 * The shim exists because SDK 2.3.0 rejects `resultType: "task"` before any result schema
 * runs. These tests feed JSON-RPC responses through `rewriteResponse` the way the SDK
 * client's `_onresponse` hook does and check that exactly that one response shape is
 * rewritten, that nothing else changes, and that the lifted task can only be taken back
 * out by identity.
 */

import { CreatedTaskShim, CREATED_TASK_META_KEY } from '../../../src/core/tasks-result-shim.js';

type Response = Parameters<CreatedTaskShim['rewriteResponse']>[0];

function response(result: unknown): Response {
  return { jsonrpc: '2.0', id: 3, result } as Response;
}

const serverMeta = { 'io.modelcontextprotocol/serverInfo': { name: 's', version: '1' } };

describe('CreatedTaskShim', () => {
  it('rewrites a CreateTaskResult into a placeholder tool result carrying the task', () => {
    const shim = new CreatedTaskShim();
    const delivered = shim.rewriteResponse(
      response({
        resultType: 'task',
        taskId: 't-1',
        status: 'working',
        createdAt: 'now',
        lastUpdatedAt: 'now',
        ttlMs: null,
        _meta: serverMeta,
      })
    ) as { id: unknown; result: Record<string, unknown> };

    expect(delivered.id).toBe(3);
    expect(delivered.result.resultType).toBe('complete');
    expect(delivered.result.content).toEqual([]);
    expect(delivered.result.isError).toBe(true);
    const meta = delivered.result._meta as Record<string, unknown>;
    // The server's own _meta survives on the placeholder next to the stash...
    expect(meta['io.modelcontextprotocol/serverInfo']).toEqual(
      serverMeta['io.modelcontextprotocol/serverInfo']
    );
    // ...and the task is the server's answer minus the wire discriminator
    expect(shim.takeCreatedTask(delivered.result)).toEqual({
      taskId: 't-1',
      status: 'working',
      createdAt: 'now',
      lastUpdatedAt: 'now',
      ttlMs: null,
      _meta: serverMeta,
    });
  });

  it('passes every other response through untouched', () => {
    const shim = new CreatedTaskShim();
    const legacyCreate = response({ task: { taskId: 't' } });
    const toolResult = response({ resultType: 'complete', content: [] });
    const inputRequired = response({ resultType: 'input_required', inputRequests: {} });
    const error = { jsonrpc: '2.0', id: 4, error: { code: -32601, message: 'nope' } } as Response;
    for (const message of [legacyCreate, toolResult, inputRequired, error]) {
      expect(shim.rewriteResponse(message)).toBe(message);
    }
  });

  it('hands a task back only for a placeholder it produced itself', () => {
    const shim = new CreatedTaskShim();
    const task = { taskId: 't-1', status: 'working' };
    // A genuine tool result that merely spells the key is not a placeholder
    const forged = {
      content: [{ type: 'text', text: 'real' }],
      _meta: { [CREATED_TASK_META_KEY]: task },
    };
    expect(shim.takeCreatedTask(forged)).toBeUndefined();
    // Neither is a placeholder from another shim instance (another McpClient)
    const other = new CreatedTaskShim().rewriteResponse(
      response({ resultType: 'task', ...task })
    ) as { result: unknown };
    expect(shim.takeCreatedTask(other.result)).toBeUndefined();
    // Non-objects and results without _meta are simply not placeholders
    expect(shim.takeCreatedTask(undefined)).toBeUndefined();
    expect(shim.takeCreatedTask({ content: [] })).toBeUndefined();
  });
});
