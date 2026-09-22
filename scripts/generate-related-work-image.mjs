#!/usr/bin/env node
// Renders the "MCP CLI clients" comparison table from README.md's "Related work"
// section into an SVG image (docs/images/related-work.svg), shown near the top of
// the README. The Markdown table is the single source of truth: edit it, then run
// `pnpm run build:readme` (or this script directly) to regenerate the image.
//
// Usage: node scripts/generate-related-work-image.mjs [--check]
//   --check  exit non-zero if the committed image is out of date

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const README = join(ROOT, 'README.md');
const OUTPUT = join(ROOT, 'docs', 'images', 'related-work.svg');
const SECTION_HEADING = '### MCP CLI clients';

// Layout (px). Text widths are estimated, so the numbers err on the roomy side.
const FONT_SIZE = 14;
const CHAR_WIDTH = 7.6; // average glyph width at FONT_SIZE, generous for bold text
const PAD = 10;
const ROW_HEIGHT = 36;
const ICON_SIZE = 18;
const ICON_COL_WIDTH = 38;
const MARGIN = 16;

function stripMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .trim();
}

function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseTable(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === SECTION_HEADING);
  if (start === -1) throw new Error(`Heading "${SECTION_HEADING}" not found in README.md`);

  let asOf = null;
  const tableLines = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#')) break;
    const asOfMatch = line.match(/as of ([A-Z][a-z]+ \d{4})/);
    if (asOfMatch && !asOf) asOf = asOfMatch[1];
    if (line.startsWith('|')) tableLines.push(line);
    else if (tableLines.length > 0) break;
  }
  if (tableLines.length < 3) throw new Error(`No table found under "${SECTION_HEADING}"`);

  const splitRow = (line) =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());

  const header = splitRow(tableLines[0]);
  const align = splitRow(tableLines[1]).map((cell) => (cell.endsWith(':') ? 'end' : 'start'));
  const rows = tableLines.slice(2).map((line) => {
    const cells = splitRow(line);
    return {
      highlight: cells[0].startsWith('**'),
      cells: cells.map(stripMarkdown),
    };
  });
  return { header: header.map(stripMarkdown), align, rows, asOf };
}

const isIcon = (value) => value === '✅' || value === '⚠️' || value === '—';

function checkIcon(cx, cy) {
  const h = ICON_SIZE / 2;
  return (
    `<rect class="ok" x="${cx - h}" y="${cy - h}" width="${ICON_SIZE}" height="${ICON_SIZE}" rx="4"/>` +
    `<path class="mark" d="M${cx - 5} ${cy + 0.5} l3.5 3.5 l6.5 -7.5"/>`
  );
}

function warnIcon(cx, cy) {
  const h = ICON_SIZE / 2;
  return (
    `<path class="warn" d="M${cx} ${cy - h} L${cx + h + 1} ${cy + h - 1} L${cx - h - 1} ${cy + h - 1} Z" stroke-linejoin="round"/>` +
    `<rect class="warn-mark" x="${cx - 1}" y="${cy - 3}" width="2" height="6" rx="1"/>` +
    `<circle class="warn-mark" cx="${cx}" cy="${cy + 5}" r="1.2"/>`
  );
}

function renderCell(value, x, width, cy, align) {
  if (value === '✅') return checkIcon(x + width / 2, cy);
  if (value === '⚠️') return warnIcon(x + width / 2, cy);
  if (value === '—')
    return `<text class="dim" x="${x + width / 2}" y="${cy}" text-anchor="middle">—</text>`;
  const tx = align === 'end' ? x + width - PAD : x + PAD;
  return `<text x="${tx}" y="${cy}" text-anchor="${align}">${escapeXml(value)}</text>`;
}

function renderSvg({ header, align, rows, asOf }) {
  // Column widths: icon-only columns are narrow, text columns fit their longest value.
  const widths = header.map((_, col) => {
    const values = rows.map((row) => row.cells[col] ?? '');
    if (col > 0 && values.every(isIcon)) return ICON_COL_WIDTH;
    const longest = Math.max(...values.map((v) => v.length));
    return Math.max(ICON_COL_WIDTH, Math.ceil(longest * CHAR_WIDTH + 2 * PAD));
  });
  const xs = widths.reduce((acc, w, i) => [...acc, acc[i] + w], [MARGIN]);
  const tableWidth = xs[xs.length - 1] - MARGIN;
  const headerHeight = Math.ceil(
    Math.max(...header.slice(1).map((h) => h.length)) * CHAR_WIDTH + 2 * PAD
  );
  const tableTop = MARGIN;
  const bodyTop = tableTop + headerHeight;
  const tableBottom = bodyTop + rows.length * ROW_HEIGHT;
  const legendY = tableBottom + 28;
  const width = tableWidth + 2 * MARGIN;
  const height = legendY + 30;

  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="${FONT_SIZE}">`,
    '<!-- Generated by scripts/generate-related-work-image.mjs from README.md. Do not edit by hand. -->',
    '<style>',
    '  .bg { fill: #ffffff; } .grid { stroke: #d0d7de; } text { fill: #1f2328; dominant-baseline: central; }',
    '  .dim { fill: #8c959f; } .hl { fill: #dafbe1; } .ok { fill: #2da44e; } .mark { fill: none; stroke: #ffffff; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }',
    '  .warn { fill: #d4a72c; } .warn-mark { fill: #1f2328; } .bold { font-weight: 700; }',
    '  @media (prefers-color-scheme: dark) {',
    '    .bg { fill: #0d1117; } .grid { stroke: #30363d; } text { fill: #e6edf3; } .dim { fill: #6e7681; } .hl { fill: #12261e; }',
    '    .ok { fill: #238636; } .warn-mark { fill: #0d1117; }',
    '  }',
    '</style>',
    `<rect class="bg" width="${width}" height="${height}"/>`
  );

  // Row backgrounds (highlighted row = mcpc itself).
  rows.forEach((row, i) => {
    if (row.highlight) {
      out.push(
        `<rect class="hl" x="${MARGIN}" y="${bodyTop + i * ROW_HEIGHT}" width="${tableWidth}" height="${ROW_HEIGHT}"/>`
      );
    }
  });

  // Rotated column headers (the first column's header stays empty, as in the image).
  header.forEach((label, col) => {
    if (col === 0) return;
    const cx = xs[col] + widths[col] / 2;
    const y = bodyTop - PAD;
    out.push(
      `<text class="bold" transform="translate(${cx} ${y}) rotate(-90)">${escapeXml(label)}</text>`
    );
  });

  // Cells.
  rows.forEach((row, i) => {
    const cy = bodyTop + i * ROW_HEIGHT + ROW_HEIGHT / 2;
    row.cells.forEach((value, col) => {
      let cell = renderCell(value, xs[col], widths[col], cy, align[col]);
      if (row.highlight && !isIcon(value)) cell = cell.replace('<text ', '<text class="bold" ');
      out.push(cell);
    });
  });

  // Grid lines.
  const grid = [];
  for (let i = 0; i <= rows.length; i++) {
    const y = bodyTop + i * ROW_HEIGHT;
    grid.push(`M${MARGIN} ${y}H${MARGIN + tableWidth}`);
  }
  grid.push(`M${xs[1]} ${tableTop}H${MARGIN + tableWidth}`);
  xs.forEach((x, i) => grid.push(`M${x} ${i === 0 ? bodyTop : tableTop}V${tableBottom}`));
  out.push(`<path class="grid" fill="none" stroke-width="1" d="${grid.join('')}"/>`);

  // Legend.
  let lx = MARGIN;
  out.push(`<text x="${lx}" y="${legendY}">Legend:</text>`);
  lx += 62;
  out.push(checkIcon(lx + ICON_SIZE / 2, legendY));
  lx += ICON_SIZE + 6;
  out.push(`<text x="${lx}" y="${legendY}">= supported,</text>`);
  lx += 92;
  out.push(warnIcon(lx + ICON_SIZE / 2, legendY));
  lx += ICON_SIZE + 6;
  const rest = `= stale (no commits in 3+ months). Full legend and notes: github.com/apify/mcpc#related-work${asOf ? ` (data as of ${asOf})` : ''}`;
  out.push(`<text x="${lx}" y="${legendY}">${escapeXml(rest)}</text>`);

  out.push('</svg>');
  return out.join('\n') + '\n';
}

function main() {
  const svg = renderSvg(parseTable(readFileSync(README, 'utf8')));
  if (process.argv.includes('--check')) {
    const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
    if (current !== svg) {
      console.error(`${OUTPUT} is out of date. Run: node scripts/generate-related-work-image.mjs`);
      process.exit(1);
    }
    console.log(`${OUTPUT} is up to date.`);
    return;
  }
  writeFileSync(OUTPUT, svg);
  console.log(`Wrote ${OUTPUT}`);
}

main();
