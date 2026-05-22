/**
 * HTML rendering for the local OAuth callback pages.
 * Shown briefly in the user's browser after the OAuth provider redirects back
 * to mcpc's local callback server.
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../logger.js';

const logger = createLogger('auth-page');

const GITHUB_URL = 'https://github.com/apify/mcpc';

/**
 * Escape HTML special characters to prevent XSS.
 * The pages render error messages from query parameters (error_description)
 * and server URLs directly into HTML, so they must be escaped.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Load the mcpc logo SVG from disk once. The file is shipped at the package
 * root and is reachable from both src/ (dev) and dist/ (published) at the
 * same relative path.
 */
let cachedLogo: string | null | undefined;
function loadLogoSvg(): string | null {
  if (cachedLogo !== undefined) return cachedLogo;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const logoPath = resolve(here, '..', '..', '..', 'client-logo.svg');
    cachedLogo = readFileSync(logoPath, 'utf8');
  } catch (err) {
    logger.debug(`Could not load logo: ${(err as Error).message}`);
    cachedLogo = null;
  }
  return cachedLogo;
}

export interface AuthPageOptions {
  success: boolean;
  title: string;
  message: string;
  detail?: string;
  /** Connection details to render as a key/value list. Falsy values are skipped. */
  info?: Array<{ label: string; value: string | undefined }>;
}

/**
 * Render the HTML page shown after the OAuth callback. Self-contained
 * (inline CSS and SVG) so it works without any network access.
 */
export function renderAuthPage(options: AuthPageOptions): string {
  const { success, title, message, detail, info } = options;
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const safeDetail = detail ? escapeHtml(detail) : '';
  const emoji = success ? '✅' : '❌';

  const logoSvg = loadLogoSvg();
  const logoBlock = logoSvg ? `<div class="logo">${logoSvg}</div>` : '';

  const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text y="26" font-size="28">${emoji}</text></svg>`;
  const faviconHref = `data:image/svg+xml,${encodeURIComponent(faviconSvg)}`;

  const infoRows = (info ?? [])
    .filter((row): row is { label: string; value: string } => Boolean(row.value))
    .map(
      (row) =>
        `<div class="row"><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd></div>`
    )
    .join('');
  const infoBlock = infoRows ? `<dl class="info">${infoRows}</dl>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="${faviconHref}">
<title>${safeTitle}</title>
<style>
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
    color: #1a1a1a;
    background: #ffffff;
    padding: 48px 48px;
    -webkit-font-smoothing: antialiased;
    line-height: 1.5;
  }
  main { max-width: 640px; }
  .logo { width: 200px; height: 200px; margin-top: 48px; }
  .logo svg { width: 100%; height: 100%; display: block; }
  h1 {
    margin: 0 0 12px;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.2px;
  }
  h1 .emoji { margin-right: 6px; }
  p { margin: 0 0 8px; font-size: 15px; }
  .info {
    margin: 18px 0 0;
    padding: 14px 16px;
    background: #f7f7f7;
    border-radius: 6px;
    font-size: 14px;
  }
  .info .row { display: flex; gap: 12px; padding: 3px 0; }
  .info dt { flex: 0 0 90px; color: #666; margin: 0; }
  .info dd {
    margin: 0;
    flex: 1;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px;
    word-break: break-word;
  }
  .detail {
    margin: 18px 0 0;
    padding: 10px 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px;
    color: #444;
    background: #f5f5f5;
    border-radius: 6px;
    word-break: break-word;
  }
  .hint { color: #666; margin-top: 18px; font-size: 14px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .footer {
    margin-top: 36px;
    padding-top: 18px;
    border-top: 1px solid #eee;
    font-size: 13px;
    color: #666;
  }
  .footer a { color: #1a1a1a; text-decoration: none; border-bottom: 1px solid #ccc; }
  .footer a:hover { border-bottom-color: #1a1a1a; }
  .footer code { color: #1a1a1a; font-weight: 600; }
</style>
</head>
<body>
  <main>
    <h1><span class="emoji" aria-hidden="true">${emoji}</span>${safeTitle}</h1>
    <p>${safeMessage}</p>
    ${infoBlock}
    ${safeDetail ? `<p class="detail">${safeDetail}</p>` : ''}
    <p class="hint">You can close this window and return to your terminal.</p>
    <div class="footer">
      <code>mcpc</code> — universal command-line client for the Model Context Protocol<br>
      <a href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer">${GITHUB_URL}</a>
    </div>
    ${logoBlock}
  </main>
</body>
</html>`;
}
