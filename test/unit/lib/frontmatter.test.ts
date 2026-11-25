/**
 * Tests for the SKILL.md frontmatter parser used to verify a fetched skill against
 * the frontmatter its server published in the skill's entry.
 */

import {
  parseSkillDocument,
  parseYamlMapping,
  diffFrontmatter,
  FrontmatterParseError,
} from '../../../src/lib/frontmatter.js';

describe('parseSkillDocument', () => {
  it('splits frontmatter from the markdown body', () => {
    const { frontmatter, body } = parseSkillDocument(
      `---
name: git-workflow
description: Follow this team's Git conventions
---

# Git workflow

Branch from main.
`
    );
    expect(frontmatter).toEqual({
      name: 'git-workflow',
      description: "Follow this team's Git conventions",
    });
    expect(body.trim()).toBe('# Git workflow\n\nBranch from main.');
  });

  it('tolerates a leading byte-order mark', () => {
    const { frontmatter } = parseSkillDocument('﻿---\nname: a\ndescription: b\n---\n');
    expect(frontmatter).toEqual({ name: 'a', description: 'b' });
  });

  it('rejects a document without a frontmatter block', () => {
    expect(() => parseSkillDocument('# No frontmatter\n')).toThrow(FrontmatterParseError);
  });

  it('rejects an unterminated frontmatter block', () => {
    expect(() => parseSkillDocument('---\nname: a\n')).toThrow(/never closed/);
  });
});

describe('parseYamlMapping', () => {
  const parse = (yaml: string): Record<string, unknown> => parseYamlMapping(yaml.split('\n'));

  it('parses scalars with YAML 1.2 core resolution', () => {
    expect(
      parse(`text: hello
quoted: "hello: world"
single: 'it''s here'
count: 10
ratio: 2.5
version: 2.1.0
yes: true
no: false
nothing: null
tilde: ~
empty:`)
    ).toEqual({
      text: 'hello',
      quoted: 'hello: world',
      single: "it's here",
      count: 10,
      ratio: 2.5,
      version: '2.1.0',
      yes: true,
      no: false,
      nothing: null,
      tilde: null,
      empty: null,
    });
  });

  it('parses block sequences, indented or not', () => {
    expect(
      parse(`allowed-tools:
  - Read
  - Write
tags:
- alpha
- beta`)
    ).toEqual({ 'allowed-tools': ['Read', 'Write'], tags: ['alpha', 'beta'] });
  });

  it('parses nested mappings', () => {
    expect(
      parse(`metadata:
  version: 1.0.0
  author:
    name: Jan
    handle: apify`)
    ).toEqual({ metadata: { version: '1.0.0', author: { name: 'Jan', handle: 'apify' } } });
  });

  it('parses flow sequences and mappings', () => {
    expect(parse('tools: [Read, Write]\nlimits: { files: 512, bytes: 16 }')).toEqual({
      tools: ['Read', 'Write'],
      limits: { files: 512, bytes: 16 },
    });
  });

  it('parses a sequence of mappings', () => {
    expect(
      parse(`hooks:
  - event: pre
    run: check.sh
  - event: post
    run: report.sh`)
    ).toEqual({
      hooks: [
        { event: 'pre', run: 'check.sh' },
        { event: 'post', run: 'report.sh' },
      ],
    });
  });

  it('parses literal and folded block scalars', () => {
    expect(
      parse(`literal: |
  line one
  line two
folded: >-
  wrapped
  text`)
    ).toEqual({ literal: 'line one\nline two\n', folded: 'wrapped text' });
  });

  it('keeps blank lines in literal block scalars', () => {
    expect(
      parse(`description: |
  first paragraph

  second paragraph`)
    ).toEqual({
      description: 'first paragraph\n\nsecond paragraph\n',
    });
  });

  it('keeps content lines that start with # in literal block scalars', () => {
    expect(
      parse(`description: |
  # Heading
  Body`)
    ).toEqual({ description: '# Heading\nBody\n' });
  });

  it('keeps relative indentation in literal block scalars', () => {
    expect(
      parse(`description: |
  first
    nested
  last`)
    ).toEqual({ description: 'first\n  nested\nlast\n' });
  });

  it('keeps trailing spaces in literal block scalars', () => {
    expect(parse('description: |\n  first  \n  last ')).toEqual({
      description: 'first  \nlast \n',
    });
  });

  it('applies keep chomping to trailing blank lines', () => {
    expect(parse('description: |+\n  first\n\n\nname: example')).toEqual({
      description: 'first\n\n\n',
      name: 'example',
    });
  });

  it('applies strip chomping to trailing blank lines', () => {
    expect(parse('description: |-\n  first\n\n\nname: example')).toEqual({
      description: 'first',
      name: 'example',
    });
  });

  it('folds a paragraph break to a newline', () => {
    expect(
      parse(`description: >
  first paragraph

  second paragraph`)
    ).toEqual({
      description: 'first paragraph\nsecond paragraph\n',
    });
  });

  it('does not fold around a more-indented line', () => {
    expect(
      parse(`description: >
  first
    nested
  last`)
    ).toEqual({ description: 'first\n  nested\nlast\n' });
  });

  it.each([
    ['k: >\n  a\n    b\n\n  c', { k: 'a\n  b\n\nc\n' }],
    ['k: >\n  a\n\n    b\n  c', { k: 'a\n\n  b\nc\n' }],
    ['k: >\n  a\n\n    b\n\n  c', { k: 'a\n\n  b\n\nc\n' }],
  ])('keeps folded breaks around more-indented lines', (yaml, expected) => {
    expect(parse(yaml)).toEqual(expected);
  });

  it.each([
    ['k: |\n  a\n  \tb', { k: 'a\n\tb\n' }],
    ['k: |\n  \t\n  a', { k: '\t\na\n' }],
    ['k: >\n  \t\n  a', { k: '\t\na\n' }],
    ['k: |\n  a\n\t\nn: 1', { k: 'a\n', n: 1 }],
    ['k: |\n\t', { k: '' }],
    ['k: |\n \t\n  a', { k: '\t\n a\n' }],
    ['k: |\n  a\n  ---', { k: 'a\n---\n' }],
    ['k: |\n  ---\n  ...\n  x', { k: '---\n...\nx\n' }],
  ])('keeps structure-like lines inside block scalars', (yaml, expected) => {
    expect(parse(yaml)).toEqual(expected);
  });

  it.each([
    ['s:\n  - |\n    text\n    more', { s: ['text\nmore\n'] }],
    ['s:\n  - >\n    text\n    more', { s: ['text more\n'] }],
    ['s:\n  - |', { s: [''] }],
  ])('parses block scalars as sequence items', (yaml, expected) => {
    expect(parse(yaml)).toEqual(expected);
  });

  it.each([
    ['literal clip mapping at EOF', 'k: |\n  ', { k: '' }],
    ['literal keep mapping at EOF', 'k: |+\n      ', { k: '\n' }],
    ['folded clip mapping before a key', 'k: >\n\n  \nn: 1', { k: '', n: 1 }],
    ['folded keep direct list item at EOF', 's:\n  - >+\n    ', { s: ['\n'] }],
    ['literal strip nested list mapping at EOF', 's:\n  - k: |-\n      ', { s: [{ k: '' }] }],
    ['folded strip mapping at EOF', 'k: >-\n \n      ', { k: '' }],
    [
      'literal clip direct list item before a key',
      's:\n  - |\n \nnext: ok',
      {
        s: [''],
        next: 'ok',
      },
    ],
    [
      'literal keep nested list mapping before a key',
      's:\n  - k: |+\n  \n     \nnext: ok',
      {
        s: [{ k: '\n\n' }],
        next: 'ok',
      },
    ],
    ['explicit indentation keeps excess spaces', 'k: |2\n     ', { k: '   \n' }],
  ])('normalizes whitespace-only block scalar bodies: %s', (_name, yaml, expected) => {
    expect(parse(yaml)).toEqual(expected);
  });

  it.each([
    ['k: |\n      \n    a'],
    ['k: >\n      \n    a'],
    ['s:\n  - |\n      \n    a'],
    ['s:\n  - k: |\n          \n      a'],
  ])('rejects over-indented leading empty lines in auto-indented block scalars', (yaml) => {
    expect(() => parse(yaml)).toThrow(/indented more than/);
  });

  it.each([
    ['k: |2\n    a', { k: '  a\n' }],
    ['k: |2\n     \n    a', { k: '   \n  a\n' }],
    ['k: >1\n  a\n  b', { k: ' a\n b\n' }],
    ['k: |2-\n    a', { k: '  a' }],
    ['k: |-2\n    a', { k: '  a' }],
    ['outer:\n  k: >+3\n       a\n       b', { outer: { k: '  a\n  b\n' } }],
  ])('honors explicit block scalar indentation indicators', (yaml, expected) => {
    expect(parse(yaml)).toEqual(expected);
  });

  it('stops a block scalar before a column-zero comment and the next key', () => {
    expect(
      parse(`description: |
  first
# outside the scalar
name: example`)
    ).toEqual({ description: 'first\n', name: 'example' });
  });

  it('keeps blank lines in a block scalar inside a sequence mapping', () => {
    expect(
      parse(`items:
  - description: |
      first

      second
    name: one`)
    ).toEqual({
      items: [{ description: 'first\n\nsecond\n', name: 'one' }],
    });
  });

  it('keeps blank lines in literal block scalars with CRLF input', () => {
    expect(
      parseSkillDocument(
        '---\r\nname: example\r\ndescription: |\r\n  first\r\n\r\n  second\r\n---\r\nbody'
      )
    ).toEqual({
      frontmatter: { name: 'example', description: 'first\n\nsecond\n' },
      body: 'body',
    });
  });

  it('strips comments but keeps # inside values', () => {
    expect(parse('name: a # trailing\nurl: "https://x/y#frag"')).toEqual({
      name: 'a',
      url: 'https://x/y#frag',
    });
  });

  it('rejects duplicate keys', () => {
    expect(() => parse('name: a\nname: b')).toThrow(/duplicate key/);
  });

  it('keeps a field named __proto__ as an own property', () => {
    // A plain assignment would make the block the object's prototype: invisible to
    // Object.keys (and so to diffFrontmatter), yet readable as result.name.
    const block = parse('__proto__:\n  name: evil');
    expect(Object.keys(block)).toEqual(['__proto__']);
    expect(block.name).toBeUndefined();
    expect(Object.getPrototypeOf(block)).toBe(Object.prototype);

    const scalar = parse('__proto__: 5');
    expect(Object.keys(scalar)).toEqual(['__proto__']);

    const flow = parse('metadata: {__proto__: {name: evil}}');
    expect(Object.keys(flow.metadata as object)).toEqual(['__proto__']);
    expect((flow.metadata as Record<string, unknown>).name).toBeUndefined();
  });

  it('rejects a duplicate __proto__ key', () => {
    expect(() => parse('__proto__: a\n__proto__: b')).toThrow(/duplicate key/);
  });

  it('rejects anchors, aliases and tags rather than guessing', () => {
    expect(() => parse('base: &anchor value')).toThrow(FrontmatterParseError);
    expect(() => parse('ref: *anchor')).toThrow(FrontmatterParseError);
    expect(() => parse('typed: !!str 5')).toThrow(FrontmatterParseError);
  });

  it('rejects tab indentation', () => {
    expect(() => parse('metadata:\n\tversion: 1')).toThrow(/tabs/);
  });

  it('rejects tabs before block scalar indentation', () => {
    expect(() => parse('k: |\n\t a')).toThrow(/tabs for indentation/);
  });

  it('rejects a more-indented line after a tab-only line ends a block scalar', () => {
    expect(() => parse('k: |\n  a\n\t\n  b')).toThrow(/unexpected indentation/);
  });

  it.each([
    ['  a: 1\n\tb: 2', /tabs for indentation/],
    ['s:\n  - a\n  \t- b', /tabs for indentation/],
    ['s:\n  - a\n  ---', /multiple YAML documents/],
    ['a: 1\n  ---', /multiple YAML documents/],
  ])('reports the intended error for malformed structural lines', (yaml, error) => {
    expect(() => parse(yaml)).toThrow(error);
  });

  it('rejects an indented document marker outside a block scalar', () => {
    expect(() => parse('metadata:\n  ---')).toThrow(
      'line 2: multiple YAML documents are not supported in frontmatter'
    );
  });
});

describe('hostile or malformed input', () => {
  const parse = (yaml: string): Record<string, unknown> => parseYamlMapping(yaml.split('\n'));

  it('splits a key with a long interior run of spaces in linear time', () => {
    // The former regex-based split backtracked quadratically on the spaces between
    // the key and the colon: 0.5 s at 20k, hours within the 10 MB IPC cap.
    const run = ' '.repeat(200_000);
    const started = performance.now();
    expect(parse(`a${run}b: v`)).toEqual({ [`a${run}b`]: 'v' });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('still accepts quoted keys with colons and plain keys with interior spaces', () => {
    expect(parse('"a: b": 1\nmy key: 2\n\'c: d\': 3')).toEqual({
      'a: b': 1,
      'my key': 2,
      'c: d': 3,
    });
  });

  it('rejects a colon that is not followed by whitespace as a key separator', () => {
    expect(() => parse('http://example.com: x')).toThrow(FrontmatterParseError);
  });

  it('rejects flow collections nested deeper than the limit', () => {
    const deep = `x: ${'['.repeat(100)}${']'.repeat(100)}`;
    expect(() => parse(deep)).toThrow(FrontmatterParseError);
    expect(() => parse(deep)).toThrow(/nested deeper than 32 levels/);
  });

  it('rejects block mappings nested deeper than the limit', () => {
    const deep = Array.from({ length: 100 }, (_, i) => `${' '.repeat(i)}k${i}:`).join('\n');
    expect(() => parse(deep)).toThrow(/nested deeper than 32 levels/);
  });

  it('rejects a chain alternating `- key:` items and nested lists deeper than the limit', () => {
    // `- k0:` starts a mapping whose `k0:` value is a list at the mapping's own indent,
    // whose item starts another mapping, and so on: parseMapping and parseSequence call
    // each other directly on this path, so the cap must hold there too. Before the check
    // moved into both, a ~9 MB SKILL.md of this shape (inside the IPC cap) overflowed the
    // stack with a RangeError instead of a parse error.
    const deep = [
      'a:',
      ...Array.from({ length: 100 }, (_, i) => `${' '.repeat(2 * i + 2)}- k${i}:`),
    ].join('\n');
    expect(() => parse(deep)).toThrow(FrontmatterParseError);
    expect(() => parse(deep)).toThrow(/nested deeper than 32 levels/);
  });

  it('accepts nesting well within the limit', () => {
    const nested = Array.from({ length: 10 }, (_, i) => `${' '.repeat(i)}k${i}:`).join('\n');
    expect(parse(`${nested} leaf`)).toEqual(
      Array.from({ length: 10 }).reduceRight<unknown>(
        (inner, _, i) => ({ [`k${i}`]: inner }),
        'leaf'
      )
    );
  });

  it('rejects a field indented less than the first field instead of dropping it', () => {
    expect(() => parse('  name: a\n  description: b\nallowed-tools: [Bash]')).toThrow(
      /indented less than the first field/
    );
  });

  it("rejects a list item field indented less than the item's first field", () => {
    expect(() => parse('hooks:\n  - event: pre\n   run: x\nname: a')).toThrow(
      /indented less than the item's first field/
    );
  });
});

describe('diffFrontmatter', () => {
  it('reports a __proto__ field the entry does not have', () => {
    const { frontmatter } = parseSkillDocument(
      '---\nname: a\ndescription: b\n__proto__:\n  extra: hidden\n---\nbody'
    );
    expect(diffFrontmatter(frontmatter, { name: 'a', description: 'b' })).toEqual(['__proto__']);
  });

  it('never matches a field against a value inherited from Object.prototype', () => {
    const inherited = String(Object.prototype.toString);
    expect(diffFrontmatter({ name: 'a' }, { name: 'a', toString: inherited })).toEqual([
      'toString',
    ]);
  });

  it('reports no differences for identical fields', () => {
    expect(
      diffFrontmatter({ name: 'a', description: 'b' }, { name: 'a', description: 'b' })
    ).toEqual([]);
  });

  it('reports fields that differ, are missing, or were added', () => {
    expect(
      diffFrontmatter(
        { name: 'a', description: 'b', license: 'MIT' },
        { name: 'a', description: 'changed' }
      )
    ).toEqual(['description', 'license']);
  });

  it('treats a scalar and its text form as equal, since YAML typing varies by library', () => {
    expect(diffFrontmatter({ version: 2.1 }, { version: '2.1' })).toEqual([]);
    expect(diffFrontmatter({ enabled: true }, { enabled: 'true' })).toEqual([]);
  });

  it('compares nested structures', () => {
    expect(
      diffFrontmatter({ metadata: { version: '1.0' } }, { metadata: { version: '2.0' } })
    ).toEqual(['metadata']);
    expect(diffFrontmatter({ tools: ['a', 'b'] }, { tools: ['a'] })).toEqual(['tools']);
  });
});
