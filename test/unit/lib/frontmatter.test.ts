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

  it('strips comments but keeps # inside values', () => {
    expect(parse('name: a # trailing\nurl: "https://x/y#frag"')).toEqual({
      name: 'a',
      url: 'https://x/y#frag',
    });
  });

  it('rejects duplicate keys', () => {
    expect(() => parse('name: a\nname: b')).toThrow(/duplicate key/);
  });

  it('rejects anchors, aliases and tags rather than guessing', () => {
    expect(() => parse('base: &anchor value')).toThrow(FrontmatterParseError);
    expect(() => parse('ref: *anchor')).toThrow(FrontmatterParseError);
    expect(() => parse('typed: !!str 5')).toThrow(FrontmatterParseError);
  });

  it('rejects tab indentation', () => {
    expect(() => parse('metadata:\n\tversion: 1')).toThrow(/tabs/);
  });
});

describe('diffFrontmatter', () => {
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
