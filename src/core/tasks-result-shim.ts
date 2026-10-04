/**
 * Lets the official SDK v2 client (`@modelcontextprotocol/client` 2.3.0) carry the one
 * piece of the tasks extension (`io.modelcontextprotocol/tasks`, MCP 2026-07-28) it does
 * not decode yet: a `tools/call` answered with a task instead of a tool result.
 *
 * SDK 2.3.0 does the rest itself. `tasks/get` and `tasks/cancel` pass its outbound era
 * gate when issued through `client.request()` with an explicit result schema, and its
 * Streamable HTTP transport sets the `Mcp-Name: <taskId>` routing header the spec requires
 * on them. But its 2026-07-28 result decoder accepts only `resultType: "complete"` and
 * `"input_required"`: a `CreateTaskResult` (`resultType: "task"`) is rejected as an
 * unsupported result type before the caller's result schema runs, and the task — its ID
 * included — is lost.
 *
 * So the response is rewritten before the SDK decodes it. `McpClient` installs
 * {@link CreatedTaskShim.rewriteResponse} in the SDK client's `_onresponse` hook (the
 * documented subclass seam for inbound responses, which runs before decoding). It turns
 * the task response into a placeholder `CallToolResult` the decoder accepts and hands the
 * task over in `_meta` ({@link CREATED_TASK_META_KEY}). {@link CreatedTaskShim.takeCreatedTask}
 * recognizes the placeholder by object identity, so a server cannot forge one by sending
 * that `_meta` key itself.
 *
 * Remove this module once the SDK ships its own tasks extension (`client/ext/tasks`);
 * `McpClient` is its only consumer.
 */

import type { JSONRPCResponse } from '@modelcontextprotocol/client';

/**
 * `_meta` key under which the placeholder result carries the task a server created in
 * lieu of a tool result. Never printed: `McpClient` unwraps it before anything else sees
 * the result.
 */
export const CREATED_TASK_META_KEY = 'com.apify.mcpc/created-task';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rewrites `CreateTaskResult` responses for one SDK client and hands the tasks back out.
 * One instance per `McpClient`; `takeCreatedTask` only recognizes placeholders this
 * instance produced.
 */
export class CreatedTaskShim {
  /** Task objects lifted out of `CreateTaskResult` responses, by identity. */
  private readonly created = new WeakSet<object>();

  /**
   * Turn a `CreateTaskResult` response into a placeholder the SDK's 2026-era decoder
   * accepts for `tools/call`, carrying the task in `_meta`. Every other response passes
   * through untouched — in particular the 2025-11-25 `CreateTaskResult` (`{ task }`, no
   * `resultType`) is decoded by the SDK as before.
   *
   * The task is the result minus the wire discriminator; it keeps whatever else the server
   * sent (`_meta` included), so `--json` shows the server's answer. The server's `_meta`
   * also stays on the placeholder, where the SDK reads per-response identity from.
   */
  rewriteResponse(response: JSONRPCResponse): JSONRPCResponse {
    if (!('result' in response)) return response;
    const result: unknown = response.result;
    if (!isRecord(result) || result.resultType !== 'task') return response;

    const { resultType: _resultType, ...task } = result;
    this.created.add(task);
    const placeholder = {
      resultType: 'complete',
      content: [],
      // The SDK validates a tool result's `structuredContent` against the tool's
      // `outputSchema` unless the result is an error. This placeholder carries no tool
      // output at all — the task does — so the flag keeps that check off it. McpClient
      // discards the placeholder as soon as it has taken the task out of it.
      isError: true,
      _meta: { ...(isRecord(task._meta) ? task._meta : {}), [CREATED_TASK_META_KEY]: task },
    };
    return { ...response, result: placeholder } as JSONRPCResponse;
  }

  /**
   * The task a server created in lieu of the tool result, when `result` is a placeholder
   * this shim produced; `undefined` for any genuine tool result — including one whose
   * `_meta` merely spells the same key, since only the object lifted here has the identity
   * `created` remembers.
   */
  takeCreatedTask(result: unknown): Record<string, unknown> | undefined {
    if (!isRecord(result) || !isRecord(result._meta)) return undefined;
    const task = result._meta[CREATED_TASK_META_KEY];
    return isRecord(task) && this.created.has(task) ? task : undefined;
  }
}
