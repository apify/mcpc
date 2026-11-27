import { execFileSync, spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import chalk from 'chalk';
const originalLevel = chalk.level;
// Set color before output.ts constructs its palette, even in a non-TTY CI worker.
chalk.level = 3;
const { formatTools, formatJson, theme, styleInlineCode, commandExample, commandHint } =
  await import('../../../src/cli/output.js');

const cli = (...args: string[]) =>
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '3', NO_COLOR: undefined },
  });

beforeAll(() => {
  chalk.level = 3;
});
afterAll(() => {
  chalk.level = originalLevel;
});

describe('terminal example colors', () => {
  it('colors command spans without coloring their aligned descriptions', () => {
    const help = cli('help', 'grep');
    expect(help).toContain('\x1b');
    expect(help).toContain(theme.cyan('mcpc grep "search"'));
    expect(stripVTControlCharacters(help)).toContain(
      'mcpc grep "search"                        Search tools'
    );
  });

  it('uses gray backticks and cyan inline code in command help', () => {
    const help = cli('help', 'tools-call');
    expect(help).toContain(chalk.gray('`') + theme.cyan('CallToolResult') + chalk.gray('`'));
  });

  it('uses the JSON output palette within shell-quoted example data', () => {
    const help = cli('help', 'tools-call');
    expect(help).toContain(
      "'" + '{' + theme.cyan('"query"') + ':' + theme.green('"hello"') + '}' + "'"
    );
  });

  it('colors human tool hints with the same inline-code treatment', () => {
    const hint = formatTools([{ name: 'search', inputSchema: { type: 'object' } }], {
      sessionName: '@demo',
    });
    expect(hint).toContain(
      chalk.gray('`') + theme.cyan('mcpc @demo tools-list --full') + chalk.gray('`')
    );
  });

  it('retains the existing highlighted JSON byte contract', () => {
    const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    try {
      expect(formatJson({ key: 'text', yes: true, absent: null, number: 2 })).toBe(
        '{\n  ' +
          theme.cyan('"key"') +
          ': ' +
          theme.green('"text"') +
          ',\n  ' +
          theme.cyan('"yes"') +
          ': ' +
          theme.magenta('true') +
          ',\n  ' +
          theme.cyan('"absent"') +
          ': ' +
          theme.magenta('null') +
          ',\n  ' +
          theme.cyan('"number"') +
          ': ' +
          theme.yellow('2') +
          '\n}'
      );
    } finally {
      if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  });
});

describe('inline code boundaries and color policy', () => {
  it('preserves already styled, multiline, empty and unpaired spans', () => {
    const values = ['`unterminated', '`two\nlines`', '``', '`' + theme.cyan('styled') + '`'];
    for (const value of values) expect(styleInlineCode(value)).toBe(value);
    expect(styleInlineCode('a `x\nb `y` c')).toBe(
      'a `x\nb ' + chalk.gray('`') + theme.cyan('y') + chalk.gray('`') + ' c'
    );
  });

  it('colors shape keys while leaving type names and punctuation unchanged', () => {
    const shape = '{ content?: Tool[], nested: { value: string }, flag: true, count: 2 }';
    const styled = styleInlineCode('`' + shape + '`');
    expect(stripVTControlCharacters(styled)).toBe('`' + shape + '`');
    expect(styled).toContain(theme.cyan('content?') + ': Tool[]');
    expect(styled).toContain(theme.cyan('value') + ': string');
    expect(styled).toContain(theme.magenta('true'));
    expect(styled).toContain(theme.yellow('2'));
  });

  it('composes bright and dim examples without changing command text', () => {
    const text = 'mcpc @demo tools-list --full';
    expect(commandExample(text)).toBe(theme.cyan(text));
    expect(commandHint(text)).toBe(chalk.dim(theme.cyan(text)));
    expect(stripVTControlCharacters(commandHint(text))).toBe(text);
    const surrounded = chalk.dim('run ' + commandExample(text) + ' now');
    expect(stripVTControlCharacters(surrounded)).toBe('run ' + text + ' now');
    expect(surrounded).toBe(chalk.dim('run ' + theme.cyan(text) + ' now'));
  });

  it('preserves visible help and line widths under forced color and NO_COLOR', () => {
    for (const args of [
      ['--help'],
      ['help', 'grep'],
      ['help', 'tools-call'],
      ['@demo', '--help'],
    ]) {
      const colored = cli(...args);
      expect(colored).toContain('\x1b');
      const plain = execFileSync(
        process.execPath,
        ['--import', 'tsx', 'src/cli/index.ts', ...args],
        {
          encoding: 'utf8',
          env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        }
      );
      expect(plain).not.toContain('\x1b');
      expect(stripVTControlCharacters(colored)).toBe(plain);
      expect(
        stripVTControlCharacters(colored)
          .split('\n')
          .map((line) => line.length)
      ).toEqual(plain.split('\n').map((line) => line.length));
    }
  });

  it('leaves an example-bearing JSON error free of color codes', () => {
    const missing = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli/index.ts', '--json', 'login'],
      {
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: '3', NO_COLOR: undefined },
      }
    );
    expect(missing.status).toBe(1);
    const output = missing.stdout + missing.stderr;
    expect(output).not.toContain('\x1b');
    expect(output).toContain('mcpc');
  });
});
