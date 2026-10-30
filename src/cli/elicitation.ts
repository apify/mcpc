import { createInterface } from 'node:readline';

type FormRequest = {
  mode?: 'form';
  message: string;
  requestedSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  _meta?: Record<string, unknown>;
};

type FormResult = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };

type Prompt = {
  ask: (message: string) => Promise<string | undefined>;
  close: () => void;
};

function terminalPrompt(): Prompt | undefined {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return undefined;

  const readline = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  const lines = readline[Symbol.asyncIterator]();
  return {
    async ask(message) {
      process.stderr.write(message);
      const line = await lines.next();
      return line.done ? undefined : line.value;
    },
    close: () => readline.close(),
  };
}

function printable(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

export async function promptElicitation(
  request: FormRequest,
  createPrompt: () => Prompt | undefined = terminalPrompt,
  signal?: AbortSignal
): Promise<FormResult> {
  let prompt: Prompt | undefined;
  const abort = (): void => prompt?.close();
  try {
    if (signal?.aborted) return { action: 'cancel' };
    prompt = createPrompt();
    if (!prompt) return { action: 'cancel' };
    signal?.addEventListener('abort', abort, { once: true });

    const choice = await prompt.ask(
      `\nServer requests input:\n${printable(request.message)}\nSchema:\n${printable(request.requestedSchema)}\n` +
        (request._meta === undefined ? '' : `Metadata:\n${printable(request._meta)}\n`) +
        'Choose accept, decline, or cancel: '
    );
    if (choice === undefined) return { action: 'cancel' };
    switch (choice.trim().toLowerCase()) {
      case 'decline':
        return { action: 'decline' };
      case 'cancel':
        return { action: 'cancel' };
      case 'accept': {
        const input = await prompt.ask('Enter a JSON object: ');
        if (input === undefined) return { action: 'cancel' };
        const content: unknown = JSON.parse(input);
        if (content === null || typeof content !== 'object' || Array.isArray(content))
          return { action: 'cancel' };
        return { action: 'accept', content: content as Record<string, unknown> };
      }
      default:
        return { action: 'cancel' };
    }
  } catch {
    return { action: 'cancel' };
  } finally {
    signal?.removeEventListener('abort', abort);
    prompt?.close();
  }
}
