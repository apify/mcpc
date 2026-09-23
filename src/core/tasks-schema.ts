/**
 * Result validators for the tasks extension (`io.modelcontextprotocol/tasks`, MCP
 * 2026-07-28).
 *
 * The SDK's task vocabulary is the 2025-11-25 core shape (`ttl`, `pollInterval`, a result
 * fetched separately with `tasks/result`) and it has no runtime for the extension, so mcpc
 * issues the extension's requests through `client.request()` with the hand-written
 * validators below. They implement the Standard Schema v1 contract the SDK expects —
 * deliberately without pulling in a schema library, which would be a dependency paid on
 * every mcpc invocation (same approach as `skills-schema.ts`).
 *
 * Validation is strict about what the spec makes normative and a client acts on — the
 * `taskId`, the `status` and the status-specific payload (`result` when completed) — and
 * lenient about the rest: `ttlMs` is REQUIRED by the spec but mcpc enforces no TTL, so a
 * server that omits it still gets its task followed. Unknown fields pass through untouched
 * so `--json` shows what the server sent.
 *
 * Spec: https://github.com/modelcontextprotocol/ext-tasks/blob/main/specification/2026-07-28/tasks.md
 */

import type { StandardSchemaV1 } from '@modelcontextprotocol/client';
import type { ExtensionTask, TaskError, TaskStatus } from '../lib/types.js';

/** Every task status the extension defines (identical to the 2025-11-25 set). */
export const TASK_STATUSES: readonly TaskStatus[] = [
  'working',
  'input_required',
  'completed',
  'failed',
  'cancelled',
];

/** Statuses a task never leaves. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled'];

/** Whether a status is terminal (`completed`, `failed` or `cancelled`). */
export function isTerminalTaskStatus(status: string): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

/** Collects validation problems with the path that produced them. */
class Issues {
  readonly list: { message: string; path: string[] }[] = [];

  add(path: string[], message: string): void {
    this.list.push({ message, path });
  }

  get ok(): boolean {
    return this.list.length === 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build a Standard Schema v1 validator from a plain check function, so
 * `client.request()` can use it as a result schema.
 */
function standardSchema<T>(
  validate: (value: unknown, issues: Issues) => T | undefined
): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'mcpc',
      validate: (value: unknown) => {
        const issues = new Issues();
        const parsed = validate(value, issues);
        if (!issues.ok || parsed === undefined) {
          return {
            issues: issues.ok ? [{ message: 'invalid result', path: [] }] : issues.list,
          };
        }
        return { value: parsed };
      },
    },
  };
}

/** Validate the JSON-RPC error object a failed task carries. */
function parseTaskError(value: unknown, path: string[], issues: Issues): TaskError | undefined {
  if (!isRecord(value)) {
    issues.add(path, 'must be a JSON-RPC error object with code and message');
    return undefined;
  }
  const { code, message } = value;
  if (typeof code !== 'number') {
    issues.add([...path, 'code'], 'must be a number');
    return undefined;
  }
  if (typeof message !== 'string') {
    issues.add([...path, 'message'], 'must be a string');
    return undefined;
  }
  return { ...value, code, message } as TaskError;
}

/**
 * Validate one task object — the flat `Task` fields plus whatever status-specific payload
 * the status calls for. Shared by `CreateTaskResult` (seed state; never carries a
 * payload in practice), the `tasks/get` result, and `notifications/tasks`.
 *
 * `path` is where the object sits in the enclosing result, for error messages.
 */
export function parseExtensionTask(
  value: unknown,
  issues: Issues,
  path: string[] = []
): ExtensionTask | undefined {
  if (!isRecord(value)) {
    issues.add(path, 'must be a task object');
    return undefined;
  }

  let valid = true;
  const { taskId, status, statusMessage, createdAt, lastUpdatedAt, ttlMs, pollIntervalMs } = value;

  if (typeof taskId !== 'string' || taskId.length === 0) {
    issues.add([...path, 'taskId'], 'must be a non-empty string');
    valid = false;
  }
  if (typeof status !== 'string' || !(TASK_STATUSES as readonly string[]).includes(status)) {
    issues.add([...path, 'status'], `must be one of ${TASK_STATUSES.join(', ')}`);
    valid = false;
  }
  if (statusMessage !== undefined && typeof statusMessage !== 'string') {
    issues.add([...path, 'statusMessage'], 'must be a string when present');
    valid = false;
  }
  for (const [field, timestamp] of [
    ['createdAt', createdAt],
    ['lastUpdatedAt', lastUpdatedAt],
  ] as const) {
    if (typeof timestamp !== 'string') {
      issues.add([...path, field], 'must be an ISO 8601 timestamp string');
      valid = false;
    }
  }
  // REQUIRED by the spec, but a one-shot CLI enforces no TTL — tolerate its absence and
  // only reject a value that means nothing.
  if (ttlMs !== undefined && ttlMs !== null && (typeof ttlMs !== 'number' || ttlMs < 0)) {
    issues.add([...path, 'ttlMs'], 'must be a non-negative number of milliseconds, or null');
    valid = false;
  }
  if (pollIntervalMs !== undefined && (typeof pollIntervalMs !== 'number' || pollIntervalMs < 0)) {
    issues.add([...path, 'pollIntervalMs'], 'must be a non-negative number of milliseconds');
    valid = false;
  }

  // Status-specific payload. A completed task without its result is one whose outcome
  // is unreachable, so that is an error; the other payloads are checked when present.
  if (status === 'completed' && !isRecord(value.result)) {
    issues.add([...path, 'result'], 'must be present on a completed task (the request result)');
    valid = false;
  }
  let error: TaskError | undefined;
  if (value.error !== undefined) {
    error = parseTaskError(value.error, [...path, 'error'], issues);
    if (!error) valid = false;
  } else if (status === 'failed') {
    // The spec requires the error, but the status alone is already a definite outcome.
    // Report a readable placeholder rather than refuse the whole task.
    error = { code: -32603, message: 'task failed (the server sent no error details)' };
  }
  if (value.inputRequests !== undefined && !isRecord(value.inputRequests)) {
    issues.add([...path, 'inputRequests'], 'must be an object keyed by request id');
    valid = false;
  }

  if (!valid) return undefined;

  return {
    ...value,
    taskId: taskId as string,
    status: status as TaskStatus,
    createdAt: createdAt as string,
    lastUpdatedAt: lastUpdatedAt as string,
    ttlMs: typeof ttlMs === 'number' ? ttlMs : null,
    ...(error && { error }),
  } as ExtensionTask;
}

/**
 * Result schema for `tasks/get`: the `DetailedTask` for the task's current status, with
 * the wire `resultType: "complete"` already consumed by the SDK. Also validates the task
 * object a `CreateTaskResult` carries and the params of `notifications/tasks`, which the
 * spec gives the same shape.
 */
export const ExtensionTaskSchema = standardSchema<ExtensionTask>((value, issues) =>
  parseExtensionTask(value, issues)
);

/**
 * Result schema for `tasks/cancel` and `tasks/update`: an empty acknowledgement, which the
 * SDK hands over as a bare object once it has consumed `resultType`. Anything the server
 * adds passes through.
 */
export const TaskAcknowledgementSchema = standardSchema<Record<string, unknown>>(
  (value, issues) => {
    if (!isRecord(value)) {
      issues.add([], 'must be an object (an empty acknowledgement)');
      return undefined;
    }
    return value;
  }
);

/**
 * Validate a task object outside `client.request()` — the seed task lifted out of a
 * `CreateTaskResult` — and report every problem in one message.
 */
export function validateExtensionTask(value: unknown): ExtensionTask | Error {
  const issues = new Issues();
  const task = parseExtensionTask(value, issues);
  if (task && issues.ok) return task;
  const details = issues.list
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message
    )
    .join('; ');
  return new Error(`Invalid task object from server: ${details || 'not a task'}`);
}
