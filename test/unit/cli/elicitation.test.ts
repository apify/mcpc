import { describe, expect, it, vi } from 'vitest';
import { promptElicitation } from '../../../src/cli/elicitation.js';

const request = {
  message: 'Allow access?',
  requestedSchema: { type: 'object' as const, properties: { approved: { type: 'boolean' } } },
};

function promptWith(...answers: (string | undefined)[]) {
  return { ask: vi.fn().mockImplementation(async () => answers.shift()), close: vi.fn() };
}

describe('promptElicitation', () => {
  it('accepts only after an explicit choice and an object', async () => {
    const prompt = promptWith('accept', '{"approved":true}');
    await expect(promptElicitation(request, () => prompt)).resolves.toEqual({
      action: 'accept',
      content: { approved: true },
    });
    expect(prompt.ask.mock.calls[0]?.[0]).toContain('"approved"');
    expect(prompt.close).toHaveBeenCalledOnce();
  });

  it.each(['decline', 'cancel'] as const)('returns %s without asking for input', async (choice) => {
    const prompt = promptWith(choice);
    await expect(promptElicitation(request, () => prompt)).resolves.toEqual({ action: choice });
    expect(prompt.ask).toHaveBeenCalledOnce();
  });

  it.each([undefined, '', 'yes'])('cancels on an absent or ambiguous choice', async (choice) => {
    await expect(promptElicitation(request, () => promptWith(choice))).resolves.toEqual({
      action: 'cancel',
    });
  });

  it.each([undefined, 'null', '[]', 'true', 'bad json'])(
    'cancels on missing or invalid content',
    async (input) => {
      await expect(promptElicitation(request, () => promptWith('accept', input))).resolves.toEqual({
        action: 'cancel',
      });
    }
  );

  it('cancels when no terminal is available or input fails', async () => {
    await expect(promptElicitation(request, () => undefined)).resolves.toEqual({
      action: 'cancel',
    });
    const prompt = { ask: vi.fn().mockRejectedValue(new Error('EOF')), close: vi.fn() };
    await expect(promptElicitation(request, () => prompt)).resolves.toEqual({ action: 'cancel' });
    expect(prompt.close).toHaveBeenCalledOnce();
  });

  it('escapes server-supplied terminal controls', async () => {
    const prompt = promptWith('cancel');
    await promptElicitation(
      {
        ...request,
        message: '\x1b[2J\u009b2J\u202e',
        requestedSchema: { type: 'object', properties: { '\x1b': {} } },
      },
      () => prompt
    );
    const output = prompt.ask.mock.calls[0]?.[0] as string;
    expect(output).not.toMatch(/[\x1b\u009b\u202e]/);
    expect(output).toContain('\\u001b');
  });

  it('shows safely escaped metadata before asking for approval', async () => {
    const prompt = promptWith('cancel');
    await promptElicitation(
      { ...request, _meta: { warning: 'Risk \x1b[2J\u009b\u202e' } },
      () => prompt
    );
    const output = prompt.ask.mock.calls[0]?.[0] as string;
    expect(output).toContain('Metadata:');
    expect(output).toContain('Risk \\u001b[2J\\u009b\\u202e');
    expect(output.indexOf('Metadata:')).toBeLessThan(output.indexOf('Choose accept'));
    expect(output).not.toMatch(/[\x1b\u009b\u202e]/);
  });
});
