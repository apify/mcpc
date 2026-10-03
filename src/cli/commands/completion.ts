/**
 * Completion command handler (`completion/complete`)
 */

import type { CommandOptions, CompleteRequestParams } from '../../lib/types.js';
import { ClientError } from '../../lib/errors.js';
import { formatOutput, formatCompletionResult } from '../output.js';
import { withMcpClient } from '../helpers.js';
import { readCommandArgs, stringifyArgValues } from '../parser.js';

/** The two reference kinds `completion/complete` accepts, as spelled on the command line */
export const COMPLETION_REF_TYPES = ['prompt', 'resource'] as const;
export type CompletionRefType = (typeof COMPLETION_REF_TYPES)[number];

/**
 * Build the `completion/complete` params from the command line. Exported for unit tests.
 *
 * `args` is the prompt's (or template's) argument list in the same shape `prompts-get`
 * takes, in the order given. The last entry is the argument being completed and its
 * value is the text typed so far (`name:=` for none); every earlier entry is sent as
 * `context.arguments` so the server can narrow its suggestions.
 */
export function buildCompleteParams(
  refType: string,
  ref: string,
  args: Record<string, string>
): CompleteRequestParams {
  if (!(COMPLETION_REF_TYPES as readonly string[]).includes(refType)) {
    throw new ClientError(
      `Unknown reference type: "${refType}". Use "prompt" (a prompt name) or "resource" ` +
        `(a resource URI or URI template), e.g.:\n` +
        `  completion-complete prompt code_review language:=py\n` +
        `  completion-complete resource 'file:///{path}' path:=/ho`
    );
  }

  const entries = Object.entries(args);
  const last = entries.pop();
  if (!last) {
    throw new ClientError(
      `No argument to complete. Pass the arguments as for prompts-get; the last one is ` +
        `completed and the ones before it are sent as context, e.g.:\n` +
        `  completion-complete ${refType} ${ref} language:=        (every suggestion)\n` +
        `  completion-complete ${refType} ${ref} language:=py      (text typed so far)\n` +
        `  completion-complete ${refType} ${ref} language:=python framework:=fla`
    );
  }
  const [name, value] = last;
  return {
    ref:
      refType === 'prompt' ? { type: 'ref/prompt', name: ref } : { type: 'ref/resource', uri: ref },
    argument: { name, value },
    ...(entries.length > 0 && { context: { arguments: Object.fromEntries(entries) } }),
  };
}

/**
 * Ask the server for argument suggestions
 * Arguments can be provided via positional key:=value pairs, inline JSON, or stdin
 * (identical to tools-call and prompts-get); the last one is the argument completed.
 */
export async function complete(
  target: string,
  refType: string,
  ref: string,
  options: CommandOptions & {
    args?: string[];
  }
): Promise<void> {
  // Completion arguments are string-only on the wire, so auto-parsed values go back to text
  const args = stringifyArgValues(await readCommandArgs(options.args));
  const params = buildCompleteParams(refType, ref, args);

  await withMcpClient(target, options, async (client, _context) => {
    const result = await client.complete(params);

    if (options.outputMode === 'json') {
      console.log(formatOutput(result, 'json'));
      return;
    }
    console.log(formatCompletionResult(result, params, target));
  });
}
