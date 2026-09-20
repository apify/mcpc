/**
 * YAML frontmatter parsing for `SKILL.md` files.
 *
 * The skills extension requires a host to parse a fetched `SKILL.md`'s frontmatter and
 * compare it field-by-field against the `frontmatter` the server published in the skill's
 * entry — what the user sees described must be what the model receives. That check needs
 * a parser, and mcpc carries no YAML dependency (one more package on every install, for
 * one command), so this module implements the subset that Agent Skills frontmatter uses:
 * block mappings, block sequences, flow sequences and mappings of scalars, block scalars
 * (`|`, `>`), comments, and YAML 1.2 core scalar resolution.
 *
 * Anything outside that subset (anchors, aliases, tags, multiple documents, complex keys)
 * throws {@link FrontmatterParseError} rather than guessing: an unverifiable frontmatter
 * is reported as such, never silently passed.
 */

/** Thrown for malformed frontmatter, or YAML outside the supported subset. */
export class FrontmatterParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontmatterParseError';
  }
}

/** A parsed `SKILL.md`: its frontmatter fields and the markdown body after them. */
export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** One physical line, with its indentation and comment-stripped content. */
interface Line {
  indent: number;
  text: string;
  number: number;
}

const FRONTMATTER_FENCE = /^---\s*$/;
const DOCUMENT_END = /^\.\.\.\s*$/;

/**
 * Deepest nesting of block or flow collections the parser accepts. Agent Skills
 * frontmatter is a few levels deep at most; the cap keeps a hostile document from
 * driving the recursive descent into a stack overflow, which would surface as a raw
 * `RangeError` instead of a parse error.
 */
const MAX_NESTING_DEPTH = 32;

/**
 * Split a `SKILL.md` into its frontmatter fields and body.
 *
 * @throws FrontmatterParseError when the document has no frontmatter block, or its YAML
 *   is malformed or outside the supported subset
 */
export function parseSkillDocument(text: string): ParsedFrontmatter {
  // A BOM before the fence is common enough to tolerate.
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const lines = source.split(/\r?\n/);

  if (lines.length === 0 || !FRONTMATTER_FENCE.test(lines[0] ?? '')) {
    throw new FrontmatterParseError(
      'SKILL.md does not start with a YAML frontmatter block (a line containing only "---")'
    );
  }

  const end = lines.findIndex((line, index) => index > 0 && FRONTMATTER_FENCE.test(line));
  if (end === -1) {
    throw new FrontmatterParseError('SKILL.md frontmatter block is never closed by a "---" line');
  }

  const frontmatter = parseYamlMapping(lines.slice(1, end));
  return { frontmatter, body: lines.slice(end + 1).join('\n') };
}

/**
 * Parse the supported YAML subset of a frontmatter block into a plain object.
 *
 * @throws FrontmatterParseError on unsupported or malformed YAML
 */
export function parseYamlMapping(rawLines: string[]): Record<string, unknown> {
  const lines = toLines(rawLines);
  if (lines.length === 0) return {};
  const { value, next } = parseBlock(lines, 0, lines[0]!.indent, 0);
  if (next < lines.length) {
    // A line indented less than the first field ends the block early; YAML calls
    // that a bad indentation, and silently dropping the rest would let a document
    // carry fields the comparison never sees.
    throw new FrontmatterParseError(
      `line ${lines[next]!.number}: field is indented less than the first field`
    );
  }
  if (value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new FrontmatterParseError(
      'frontmatter must be a mapping of fields, not a list or scalar'
    );
  }
  return value as Record<string, unknown>;
}

/** Drop blank and comment-only lines, and reject syntax the parser will not guess at. */
function toLines(rawLines: string[]): Line[] {
  const lines: Line[] = [];
  rawLines.forEach((raw, index) => {
    const number = index + 1;
    if (raw.includes('\t') && raw.trim().length > 0 && /^\s*\t/.test(raw)) {
      throw new FrontmatterParseError(`line ${number}: YAML does not allow tabs for indentation`);
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) return;
    if (FRONTMATTER_FENCE.test(trimmed) || DOCUMENT_END.test(trimmed)) {
      throw new FrontmatterParseError(
        `line ${number}: multiple YAML documents are not supported in frontmatter`
      );
    }
    lines.push({ indent: raw.length - raw.trimStart().length, text: trimmed, number });
  });
  return lines;
}

/**
 * Parse the block starting at `start` whose entries are indented by `indent`.
 * Returns the parsed value and the index of the first line after the block.
 */
function parseBlock(
  lines: Line[],
  start: number,
  indent: number,
  depth: number
): { value: unknown; next: number } {
  const first = lines[start];
  if (!first) return { value: null, next: start };
  return first.text.startsWith('- ') || first.text === '-'
    ? parseSequence(lines, start, indent, depth)
    : parseMapping(lines, start, indent, depth);
}

function assertDepth(depth: number, lineNumber: number): void {
  if (depth > MAX_NESTING_DEPTH) {
    throw new FrontmatterParseError(
      `line ${lineNumber}: frontmatter is nested deeper than ${MAX_NESTING_DEPTH} levels`
    );
  }
}

function parseMapping(
  lines: Line[],
  start: number,
  indent: number,
  depth: number
): { value: Record<string, unknown>; next: number } {
  // The depth cap lives in parseMapping and parseSequence, not in parseBlock: the two
  // recurse into each other directly (a `key:` followed by a same-indent `- item` list,
  // and a `- key: value` item), so a chain alternating them would never pass through
  // parseBlock and would overflow the stack instead of hitting the cap.
  const first = lines[start];
  if (first) assertDepth(depth, first.number);
  const result: Record<string, unknown> = {};
  let index = start;

  while (index < lines.length) {
    const line = lines[index]!;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new FrontmatterParseError(`line ${line.number}: unexpected indentation`);
    }

    const { key, rest } = splitKey(line);
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new FrontmatterParseError(`line ${line.number}: duplicate key "${key}"`);
    }

    const blockScalar = matchBlockScalar(rest);
    if (blockScalar) {
      const { value, next } = readBlockScalar(lines, index + 1, indent, blockScalar);
      result[key] = value;
      index = next;
      continue;
    }

    if (rest.length > 0) {
      result[key] = parseScalarOrFlow(rest, line.number, depth + 1);
      index += 1;
      continue;
    }

    // Value on following lines: a nested block (more indented) or a sequence whose
    // dashes sit at the key's own indentation, which YAML also allows.
    const child = lines[index + 1];
    if (child && child.indent > indent) {
      const { value, next } = parseBlock(lines, index + 1, child.indent, depth + 1);
      result[key] = value;
      index = next;
    } else if (
      child &&
      child.indent === indent &&
      (child.text.startsWith('- ') || child.text === '-')
    ) {
      const { value, next } = parseSequence(lines, index + 1, indent, depth + 1);
      result[key] = value;
      index = next;
    } else {
      result[key] = null;
      index += 1;
    }
  }

  return { value: result, next: index };
}

function parseSequence(
  lines: Line[],
  start: number,
  indent: number,
  depth: number
): { value: unknown[]; next: number } {
  const first = lines[start];
  if (first) assertDepth(depth, first.number);
  const result: unknown[] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index]!;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new FrontmatterParseError(`line ${line.number}: unexpected indentation in list`);
    }
    if (!line.text.startsWith('- ') && line.text !== '-') break;

    const rest = line.text === '-' ? '' : line.text.slice(2).trim();

    if (rest.length === 0) {
      const child = lines[index + 1];
      if (child && child.indent > indent) {
        const { value, next } = parseBlock(lines, index + 1, child.indent, depth + 1);
        result.push(value);
        index = next;
      } else {
        result.push(null);
        index += 1;
      }
      continue;
    }

    // `- key: value` starts a mapping whose keys line up after the dash.
    if (isMappingEntry(rest)) {
      const dashOffset = line.text.indexOf('- ') + 2;
      const nested: Line[] = [{ indent: indent + dashOffset, text: rest, number: line.number }];
      let scan = index + 1;
      while (scan < lines.length && lines[scan]!.indent > indent) {
        nested.push(lines[scan]!);
        scan += 1;
      }
      const { value, next } = parseMapping(nested, 0, nested[0]!.indent, depth + 1);
      if (next < nested.length) {
        // A later field of this item sits left of its first field: bad indentation,
        // not a line to drop.
        throw new FrontmatterParseError(
          `line ${nested[next]!.number}: field is indented less than the item's first field`
        );
      }
      result.push(value);
      index = scan;
      continue;
    }

    result.push(parseScalarOrFlow(rest, line.number, depth + 1));
    index += 1;
  }

  return { value: result, next: index };
}

/** Split `key: value` into its parts, rejecting keys the subset does not cover. */
function splitKey(line: Line): { key: string; rest: string } {
  const split = splitKeyValue(line.text);
  if (!split) {
    throw new FrontmatterParseError(
      `line ${line.number}: expected a "key: value" field, got "${line.text}"`
    );
  }
  const key = split.key.trim();
  if (key.length === 0) {
    throw new FrontmatterParseError(`line ${line.number}: empty field name`);
  }
  return { key, rest: stripComment(split.rest).trim() };
}

function isMappingEntry(text: string): boolean {
  return splitKeyValue(text) !== undefined;
}

/**
 * Locate the `:` that separates a mapping key from its value: the first colon, which
 * must be followed by whitespace or end the line, after a key that is either quoted
 * (`"a: b"`) or a plain run without `:` or `#`. Returns undefined when the line is not
 * a `key: value` entry.
 *
 * Deliberately a single pass rather than a regex: the key, the whitespace before the
 * colon and the whitespace after it overlap in a pattern such as `[^:#]+?\\s*:\\s`, and a
 * backtracking engine walks that in quadratic time — a SKILL.md line with a long run of
 * spaces inside a field name kept the CLI busy for hours before it was refused.
 */
function splitKeyValue(text: string): { key: string; rest: string } | undefined {
  let keyEnd: number;
  let colon: number;

  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const closing = text.indexOf(quote, 1);
    if (closing === -1) return undefined;
    keyEnd = closing + 1;
    colon = keyEnd;
    while (colon < text.length && isSpace(text[colon]!)) colon += 1;
    if (text[colon] !== ':') return undefined;
  } else {
    colon = text.indexOf(':');
    if (colon === -1 || text.slice(0, colon).includes('#')) return undefined;
    keyEnd = colon;
  }

  const after = text[colon + 1];
  if (after !== undefined && !isSpace(after)) return undefined;

  const key = quote === '"' || quote === "'" ? text.slice(1, keyEnd - 1) : text.slice(0, keyEnd);
  return { key, rest: text.slice(colon + 1) };
}

function isSpace(char: string): boolean {
  return char === ' ' || char === '\t';
}

/** Block scalar header: `|`, `>`, with optional chomping/indentation indicators. */
function matchBlockScalar(rest: string): { fold: boolean; chomp: string } | undefined {
  const match = /^([|>])([+-]?)\s*$/.exec(rest);
  if (!match) return undefined;
  return { fold: match[1] === '>', chomp: match[2] ?? '' };
}

/** Read the more-indented lines belonging to a `|` or `>` block scalar. */
function readBlockScalar(
  lines: Line[],
  start: number,
  indent: number,
  header: { fold: boolean; chomp: string }
): { value: string; next: number } {
  const collected: string[] = [];
  let index = start;
  while (index < lines.length && lines[index]!.indent > indent) {
    collected.push(lines[index]!.text);
    index += 1;
  }
  const joined = header.fold ? collected.join(' ') : collected.join('\n');
  const value = header.chomp === '-' || joined.length === 0 ? joined : `${joined}\n`;
  return { value, next: index };
}

/** Strip a trailing `#` comment, which YAML requires to be preceded by whitespace. */
function stripComment(text: string): string {
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#' && (i === 0 || /\s/.test(text[i - 1]!))) {
      return text.slice(0, i);
    }
  }
  return text;
}

/** Parse a scalar, a flow sequence (`[a, b]`) or a flow mapping (`{a: 1}`). */
function parseScalarOrFlow(text: string, lineNumber: number, depth: number): unknown {
  if (text.startsWith('[') || text.startsWith('{')) {
    assertDepth(depth, lineNumber);
    return parseFlow(text, lineNumber, depth);
  }
  return parseScalar(text, lineNumber);
}

/**
 * Parse a flow collection of scalars. Nested flow collections are supported; anything
 * else (a flow collection spanning several lines) is rejected.
 */
function parseFlow(text: string, lineNumber: number, depth: number): unknown {
  const open = text[0]!;
  const close = open === '[' ? ']' : '}';
  if (!text.endsWith(close)) {
    throw new FrontmatterParseError(
      `line ${lineNumber}: unterminated flow collection (multi-line flow style is not supported)`
    );
  }

  const inner = text.slice(1, -1).trim();
  if (inner.length === 0) return open === '[' ? [] : {};

  const parts = splitFlowItems(inner, lineNumber);
  if (open === '[') {
    return parts.map((part) => parseScalarOrFlow(part, lineNumber, depth + 1));
  }

  const map: Record<string, unknown> = {};
  for (const part of parts) {
    const separator = findFlowColon(part);
    if (separator === -1) {
      throw new FrontmatterParseError(
        `line ${lineNumber}: flow mapping entry "${part}" has no ":"`
      );
    }
    const key = unquote(part.slice(0, separator).trim());
    map[key] = parseScalarOrFlow(part.slice(separator + 1).trim(), lineNumber, depth + 1);
  }
  return map;
}

/** Split `a, [b, c], d` on top-level commas. */
function splitFlowItems(text: string, lineNumber: number): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let current = '';

  for (const char of text) {
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === '[' || char === '{') {
      depth += 1;
      current += char;
    } else if (char === ']' || char === '}') {
      depth -= 1;
      current += char;
    } else if (char === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (quote) {
    throw new FrontmatterParseError(`line ${lineNumber}: unterminated quoted string`);
  }
  if (current.trim().length > 0) items.push(current.trim());
  return items;
}

/** Index of the `:` separating key from value in a flow mapping entry, or -1. */
function findFlowColon(text: string): number {
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ':') {
      return i;
    }
  }
  return -1;
}

function unquote(text: string): string {
  if (text.length >= 2 && (text.startsWith('"') || text.startsWith("'"))) {
    const quote = text[0]!;
    if (text.endsWith(quote)) return unescapeQuoted(text.slice(1, -1), quote);
  }
  return text;
}

function unescapeQuoted(text: string, quote: string): string {
  if (quote === "'") return text.replace(/''/g, "'");
  return text.replace(/\\(["\\/nrt])/g, (_, char: string) => {
    switch (char) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      default:
        return char;
    }
  });
}

/** YAML 1.2 core scalar resolution: null, bool, int, float, else string. */
function parseScalar(text: string, lineNumber: number): unknown {
  if (text.startsWith('&') || text.startsWith('*') || text.startsWith('!')) {
    throw new FrontmatterParseError(
      `line ${lineNumber}: YAML anchors, aliases and tags are not supported in frontmatter`
    );
  }
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0]!;
    if (!text.endsWith(quote) || text.length < 2) {
      throw new FrontmatterParseError(`line ${lineNumber}: unterminated quoted string`);
    }
    return unescapeQuoted(text.slice(1, -1), quote);
  }

  if (text.length === 0 || text === '~' || /^null$/i.test(text)) return null;
  if (/^true$/i.test(text)) return true;
  if (/^false$/i.test(text)) return false;
  if (/^[-+]?\d+$/.test(text)) return Number(text);
  if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text, 16);
  if (/^0o[0-7]+$/.test(text)) return Number.parseInt(text.slice(2), 8);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(text)) return Number(text);
  if (/^[-+]?\.inf$/i.test(text)) return text.startsWith('-') ? -Infinity : Infinity;
  if (/^\.nan$/i.test(text)) return NaN;

  return text;
}

/**
 * Compare a `SKILL.md`'s parsed frontmatter against the frontmatter a server published
 * in the skill's entry, returning the names of the fields that differ.
 *
 * Scalars are compared by their text form, so a field a server serialized as `"2.1"`
 * matches one YAML resolves to the number `2.1`. Type resolution differs between YAML
 * libraries for such scalars, and flagging that as tampering would be a false alarm; a
 * genuine difference in content still shows up.
 */
export function diffFrontmatter(
  documentFields: Record<string, unknown>,
  entryFields: Record<string, unknown>
): string[] {
  const keys = new Set([...Object.keys(documentFields), ...Object.keys(entryFields)]);
  const differing: string[] = [];
  for (const key of keys) {
    if (!looseEqual(documentFields[key], entryFields[key])) differing.push(key);
  }
  return differing.sort();
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => looseEqual(item, b[index]));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      if (!looseEqual(left[key], right[key])) return false;
    }
    return true;
  }

  if (typeof a === 'object' || typeof b === 'object') return false;

  return String(a) === String(b);
}
