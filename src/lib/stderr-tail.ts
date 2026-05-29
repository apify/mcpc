/**
 * Bounded ring buffer of stderr lines, used to surface recent output in error
 * messages when a child process (an MCP stdio server, or the bridge itself)
 * dies before it can write proper logs. The cap keeps memory predictable even
 * against a runaway logger; the per-line cap keeps a single huge line from
 * pushing every other line out or being dumped wholesale.
 */
export class StderrTail {
  private static readonly MAX_LINES = 50;
  private static readonly MAX_CHARS = 8_000;

  private readonly lines: string[] = [];
  private chars = 0;

  /**
   * Append a stderr line. Empty lines are dropped. Long lines are truncated
   * to MAX_CHARS with an ellipsis. Returns the stored (possibly truncated)
   * form so callers can log the same text we kept, or null for a dropped line.
   */
  add(line: string): string | null {
    if (line.length === 0) return null;
    const trimmed =
      line.length > StderrTail.MAX_CHARS ? line.slice(0, StderrTail.MAX_CHARS) + '…' : line;
    this.lines.push(trimmed);
    this.chars += trimmed.length + 1;
    while (
      this.lines.length > StderrTail.MAX_LINES ||
      (this.lines.length > 1 && this.chars > StderrTail.MAX_CHARS)
    ) {
      const dropped = this.lines.shift();
      if (dropped === undefined) break;
      this.chars -= dropped.length + 1;
    }
    return trimmed;
  }

  get count(): number {
    return this.lines.length;
  }

  /** Two-space-indented multi-line block (no header). Empty when no lines. */
  format(): string {
    return this.lines.map((l) => `  ${l}`).join('\n');
  }
}
