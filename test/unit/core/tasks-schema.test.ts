/**
 * Unit tests for the tasks-extension result validators (src/core/tasks-schema.ts).
 */

import {
  ExtensionTaskSchema,
  TaskAcknowledgementSchema,
  isTerminalTaskStatus,
  validateExtensionTask,
} from '../../../src/core/tasks-schema.js';

const base = {
  taskId: 't-1',
  status: 'working',
  createdAt: '2026-09-23T10:00:00Z',
  lastUpdatedAt: '2026-09-23T10:00:05Z',
  ttlMs: 60_000,
  pollIntervalMs: 5_000,
};

async function validate(value: unknown) {
  return ExtensionTaskSchema['~standard'].validate(value);
}

describe('ExtensionTaskSchema', () => {
  it('accepts a working task and passes unknown fields through', async () => {
    const outcome = await validate({ ...base, statusMessage: 'busy', _meta: { x: 1 } });
    expect(outcome).toEqual({
      value: { ...base, statusMessage: 'busy', _meta: { x: 1 } },
    });
  });

  it('accepts every status the spec defines', async () => {
    for (const status of ['working', 'input_required', 'cancelled']) {
      expect((await validate({ ...base, status })).issues).toBeUndefined();
    }
    expect(
      (await validate({ ...base, status: 'completed', result: { content: [] } })).issues
    ).toBeUndefined();
    expect(
      (await validate({ ...base, status: 'failed', error: { code: -1, message: 'x' } })).issues
    ).toBeUndefined();
  });

  it('rejects a task without an id or with an unknown status', async () => {
    const noId = await validate({ ...base, taskId: '' });
    expect(noId.issues?.[0]?.path).toEqual(['taskId']);
    const badStatus = await validate({ ...base, status: 'paused' });
    expect(badStatus.issues?.[0]?.path).toEqual(['status']);
    expect(badStatus.issues?.[0]?.message).toContain('working, input_required');
  });

  it('rejects a completed task that carries no result', async () => {
    const outcome = await validate({ ...base, status: 'completed' });
    expect(outcome.issues?.[0]?.path).toEqual(['result']);
  });

  it('tolerates a missing ttlMs (normalized to null) but not a nonsensical one', async () => {
    const { ttlMs: _ignored, ...withoutTtl } = base;
    void _ignored;
    const outcome = await validate(withoutTtl);
    expect(outcome.issues).toBeUndefined();
    expect((outcome as { value: { ttlMs: unknown } }).value.ttlMs).toBeNull();
    expect((await validate({ ...base, ttlMs: -5 })).issues?.[0]?.path).toEqual(['ttlMs']);
    expect((await validate({ ...base, ttlMs: null })).issues).toBeUndefined();
  });

  it('rejects a malformed error object and fills in one for a failed task without it', async () => {
    const bad = await validate({ ...base, status: 'failed', error: 'boom' });
    expect(bad.issues?.[0]?.path).toEqual(['error']);
    const bare = await validate({ ...base, status: 'failed' });
    expect(bare.issues).toBeUndefined();
    expect((bare as { value: { error: { code: number } } }).value.error.code).toBe(-32603);
  });

  it('rejects timestamps and inputRequests of the wrong type', async () => {
    expect((await validate({ ...base, createdAt: 5 })).issues?.[0]?.path).toEqual(['createdAt']);
    expect((await validate({ ...base, inputRequests: [] })).issues?.[0]?.path).toEqual([
      'inputRequests',
    ]);
  });

  it('rejects non-objects', async () => {
    expect((await validate('task')).issues).toHaveLength(1);
    expect((await validate(null)).issues).toHaveLength(1);
  });
});

describe('validateExtensionTask', () => {
  it('returns the task or an Error listing every problem', () => {
    expect(validateExtensionTask(base)).toMatchObject({ taskId: 't-1' });
    const error = validateExtensionTask({ status: 'nope' });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('taskId: must be a non-empty string');
    expect((error as Error).message).toContain('status: must be one of');
  });
});

describe('TaskAcknowledgementSchema', () => {
  it('accepts any object and rejects anything else', async () => {
    const schema = TaskAcknowledgementSchema['~standard'];
    expect(await schema.validate({})).toEqual({ value: {} });
    expect(await schema.validate({ extra: 1 })).toEqual({ value: { extra: 1 } });
    expect((await schema.validate('ok')).issues).toHaveLength(1);
  });
});

describe('isTerminalTaskStatus', () => {
  it('knows the three terminal states', () => {
    expect(['completed', 'failed', 'cancelled'].every(isTerminalTaskStatus)).toBe(true);
    expect(['working', 'input_required', 'other'].some(isTerminalTaskStatus)).toBe(false);
  });
});
