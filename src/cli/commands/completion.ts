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
 * `args` holds the prompt's (or template's) arguments as filled in so far, in the same
 * shape `prompts-get` takes: the entry named by `argument` is the partial value typed so
 * far (absent = empty, i.e. ask for every suggestion), every other entry is sent as
 * `context.arguments` so the server can narrow its suggestions.
 */
export function buildCompleteParams(
  refType: string,
  ref: string,
  argument: string,
  args: Record<string, string>
): CompleteRequestParams {
  if (!(COMPLETION_REF_TYPES as readonly string[]).includes(refType)) {
    throw new ClientError(
      `Unknown reference type: "${refType}". Use "prompt" (a prompt name) or "resource" ` +
        `(a resource URI or URI template), e.g.:\n` +
        `  completion-complete prompt code_review language language:=py\n` +
        `  completion-complete resource 'file:///{path}' path path:=/ho`
    );
  }

  const { [argument]: value = '', ...context } = args;
  return {
    ref:
      refType === 'prompt' ? { type: 'ref/prompt', name: ref } : { type: 'ref/resource', uri: ref },
    argument: { name: argument, value },
    ...(Object.keys(context).length > 0 && { context: { arguments: context } }),
  };
}

/**
 * Ask the server for argument suggestions
 * Arguments can be provided via positional key:=value pairs, inline JSON, or stdin
 * (identical to tools-call and prompts-get).
 */
export async function complete(
  target: string,
  refType: string,
  ref: string,
  argument: string,
  options: CommandOptions & {
    args?: string[];
  }
): Promise<void> {
  // Completion arguments are string-only on the wire, so auto-parsed values go back to text
  const args = stringifyArgValues(await readCommandArgs(options.args));
  const params = buildCompleteParams(refType, ref, argument, args);

  await withMcpClient(target, options, async (client, _context) => {
    const result = await client.complete(params);

    if (options.outputMode === 'json') {
      console.log(formatOutput(result, 'json'));
      return;
    }
    console.log(formatCompletionResult(result, params, target));
  });
}
