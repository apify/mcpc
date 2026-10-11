#!/usr/bin/env node
/**
 * Demo script that prints example mcpc command output with proper colors
 * Used for creating leaflets and documentation showcasing the CLI
 *
 * Usage: node scripts/demo-output.mjs
 */

import chalk from 'roundel/chalk';

/**
 * Convert HSL to RGB hex color
 */
function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Apply a soft, fog-filtered rainbow gradient to a string
 * Inspired by SF's coastal aesthetic: Golden Gate Bridge emerging from mist
 */
function rainbow(text) {
  const len = text.length;
  if (len === 0) return text;

  return text
    .split('')
    .map((char, i) => {
      const hue = 12 + (i / (len - 1)) * 270;
      const hex = hslToHex(hue, 45, 62);
      return chalk.hex(hex)(char);
    })
    .join('');
}

// Helper functions matching output.ts styling
function grayBacktick() {
  return chalk.gray('`');
}

function inBackticks(text) {
  return `${grayBacktick()}${chalk.cyan(text)}${grayBacktick()}`;
}

function comment(text) {
  return chalk.gray(`# ${text}`);
}

function prompt(command) {
  return `${chalk.green('❯')} ${chalk.bold(command)}`;
}

function sessionLine(name, target, info, status) {
  const statusColors = {
    live: chalk.green('●') + ' ' + chalk.green('live'),
    crashed: chalk.yellow('●') + ' ' + chalk.yellow('crashed'),
    expired: chalk.red('●') + ' ' + chalk.red('expired'),
  };
  return `  ${chalk.cyan(name)} → ${target} ${chalk.dim(`(${info})`)} ${statusColors[status]}`;
}

function toolLine(name, annotations) {
  const bullet = chalk.dim('*');
  const annotationsStr = annotations.length > 0 ? ` ${chalk.gray(`[${annotations.join(', ')}]`)}` : '';
  return `${bullet} ${inBackticks(name)}${annotationsStr}`;
}

function destructiveAnnotation(text) {
  return chalk.red(text);
}

// Print the demo output
console.log();
console.log(
  chalk.gray('# ') +
    chalk.bold(
      `mcpc: ${rainbow('Universal')} command-line client for the Model Context Protocol (MCP).`
    )
);
console.log();

console.log(comment('Install mcpc'));
console.log(prompt('npm install -g @apify/mcpc'));
console.log();

console.log(comment('List all active sessions and saved authentication profiles'));
console.log(prompt('mcpc'));
console.log('MCP sessions:');
console.log(sessionLine('@playwright', 'npx @playwright/mcp@latest', 'stdio', 'live'));
console.log(sessionLine('@fs', 'npx -y @modelcontextprotocol/server-filesystem /Users/bob', 'stdio', 'live'));
console.log(sessionLine('@apify', 'https://mcp.apify.com', `HTTP, OAuth: ${chalk.magenta('default')}`, 'live'));
console.log();
console.log('Available OAuth profiles:');
console.log(`  mcp.apify.com / ${chalk.magenta('default')}, created 35m ago`);
console.log();

console.log(comment('List MCP server tools'));
console.log(prompt('mcpc @apify tools-list'));
// console.log(`[${chalk.cyan('@apify')} → https://mcp.apify.com ${chalk.dim(`(HTTP, OAuth: ${chalk.magenta('default')})`)}]`);
console.log();
console.log('Available tools (3):');
console.log(toolLine('search-actors', ['read-only', 'idempotent']));
console.log(toolLine('fetch-actor-details', ['read-only', 'idempotent']));
console.log(toolLine('call-actor', [destructiveAnnotation('destructive'), 'open-world']));
// console.log();
// console.log('For full details, use "tools-list --full" or "tools-get <name>"');
console.log();

console.log(comment('Use JSON output for scripting and code mode'));
console.log(prompt('mcpc @apify tools-list --json'));
console.log();

console.log(comment('Call tools using CLI'));
console.log(prompt('mcpc @apify tools-call search-actors keywords:="website crawler"'));
console.log();

console.log(comment('Start local MCP proxy to remote server for secure AI sandbox access'));
console.log(prompt('mcpc mcp.apify.com connect @my-proxy --proxy 8080'));
console.log();

console.log(comment('...and much more'));
console.log();
