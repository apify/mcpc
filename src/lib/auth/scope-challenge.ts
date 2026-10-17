/**
 * OAuth scope challenges and the step-up authorization flow
 * (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#step-up-authorization-flow).
 *
 * A server that wants more scopes than the current token carries answers
 * `403 Forbidden` with `WWW-Authenticate: Bearer error="insufficient_scope",
 * scope="..."`. The spec asks the client to union the challenged scopes with the
 * ones it already requested, re-authorize with that union and retry.
 *
 * mcpc never opens a browser on its own, so the bridge cannot step up an
 * authorization-code session by itself. Instead the error that reaches the user
 * names the missing scope and carries the exact `login --scope "<union>"` command
 * that performs the step-up. The `login` command, in turn, reads the 401 challenge
 * of a server before authorizing so the first login already asks for the scopes
 * the server wants, unioned with the scopes an existing profile was granted.
 *
 * Dependency-free: imported by the CLI at startup (via the bridge manager) and by
 * the bridge, so it must not pull in the MCP SDK.
 */

/** The parameters of an `insufficient_scope` challenge the server sent. */
export interface ScopeChallenge {
  /** The `scope` parameter: the scopes the server requires for the operation. */
  requiredScope?: string;
  /** The `error_description` parameter, if the server sent one. */
  errorDescription?: string;
}

/**
 * Space-delimited scope strings (RFC 6749 §3.3) and scope arrays merged into one
 * string with every distinct scope exactly once, in first-seen order. Returns
 * undefined when nothing was given.
 */
export function unionScopes(
  ...scopes: Array<string | readonly string[] | undefined>
): string | undefined {
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (!scope) continue;
    const tokens = typeof scope === 'string' ? scope.split(/\s+/) : scope;
    for (const token of tokens) {
      if (token) seen.add(token);
    }
  }
  return seen.size > 0 ? [...seen].join(' ') : undefined;
}

/**
 * Find the `insufficient_scope` challenge behind an error, if there is one.
 *
 * The MCP SDK transport throws an `InsufficientScopeError` (branded
 * `mcp.InsufficientScopeError`) when a 403 `insufficient_scope` arrives and it has
 * no OAuth provider to step up with — which is the case for every session mcpc
 * authenticates with a token of its own. mcpc wraps such errors (`ServerError`
 * with `details.originalError`, or `cause`), so the chain is walked.
 */
export function findScopeChallenge(error: unknown): ScopeChallenge | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      constructor?: { mcpBrand?: unknown };
      mcpBrand?: unknown;
      requiredScope?: unknown;
      errorDescription?: unknown;
      cause?: unknown;
      details?: unknown;
    };
    const brand = candidate.constructor?.mcpBrand ?? candidate.mcpBrand;
    if (brand === 'mcp.InsufficientScopeError') {
      return {
        ...(typeof candidate.requiredScope === 'string' && candidate.requiredScope !== ''
          ? { requiredScope: candidate.requiredScope }
          : {}),
        ...(typeof candidate.errorDescription === 'string' && candidate.errorDescription !== ''
          ? { errorDescription: candidate.errorDescription }
          : {}),
      };
    }
    const details = candidate.details as { originalError?: unknown } | undefined;
    current = details?.originalError ?? candidate.cause;
  }
  return undefined;
}

/** What the step-up hint needs to know about the session the challenge hit. */
export interface ScopeChallengeContext {
  /** MCP server URL, as the user would pass it to `login`. */
  serverUrl: string;
  /** Session name (`@name`) for the `restart` hint; absent on a direct connect. */
  sessionName?: string;
  /**
   * The OAuth profile the session authenticates with, and the scopes it was granted.
   * Absent when the session carries a static `Authorization` header (or no auth at
   * all) — mcpc cannot re-request such a token.
   */
  profile?: { name: string; scopes?: readonly string[] | undefined };
  /** Quote a value for a copy-paste shell hint (the scope is server-controlled). */
  quote: (value: string) => string;
}

/**
 * Explain an `insufficient_scope` challenge and how to satisfy it.
 *
 * The message avoids the words the auth-error classifier (`isAuthenticationError`)
 * matches on: the token itself is still valid, so the session must stay usable
 * for everything else rather than be marked `unauthorized`.
 */
export function describeScopeChallenge(
  challenge: ScopeChallenge,
  context: ScopeChallengeContext
): string {
  const required = challenge.requiredScope;
  const lines: string[] = [];

  lines.push(
    required
      ? `Insufficient scope: the server requires scope ${JSON.stringify(required)} for this operation.`
      : 'Insufficient scope: the server requires a scope for this operation that the current token lacks.'
  );
  if (challenge.errorDescription) {
    lines.push(`Server says: ${challenge.errorDescription}`);
  }

  if (context.profile) {
    const granted = context.profile.scopes ?? [];
    if (granted.length > 0) {
      lines.push(`Profile "${context.profile.name}" was granted: ${granted.join(' ')}`);
    }
    const union = unionScopes(granted, required);
    const profileFlag =
      context.profile.name === 'default' ? '' : ` --profile ${context.quote(context.profile.name)}`;
    const scopeFlag = union ? ` --scope ${context.quote(union)}` : '';
    lines.push('');
    lines.push(
      union
        ? 'To add the missing scope, log in again requesting all of them' +
            (context.sessionName ? ', then restart the session:' : ':')
        : 'To request it, log in again' +
            (context.sessionName ? ', then restart the session:' : ':')
    );
    lines.push(`  mcpc login ${context.quote(context.serverUrl)}${profileFlag}${scopeFlag}`);
    if (context.sessionName) {
      lines.push(`  mcpc ${context.sessionName} restart`);
    }
  } else {
    lines.push('');
    lines.push(
      'This session does not use an OAuth profile, so mcpc cannot request the scope itself. ' +
        'Obtain a token that includes it and reconnect with the new Authorization header, ' +
        'or log in with an OAuth profile:'
    );
    lines.push(
      `  mcpc login ${context.quote(context.serverUrl)}${required ? ` --scope ${context.quote(required)}` : ''}`
    );
  }

  return lines.join('\n');
}

/**
 * Parse the parameters of a `WWW-Authenticate` header (RFC 6750 §3 / RFC 9110
 * §11.6.1): `Bearer realm="x", scope="a b", error=insufficient_scope`.
 *
 * Only the `Bearer` challenge is read. Returns the parameters that matter for
 * scope selection, or undefined when the header is absent or carries no Bearer
 * challenge. Quoted values are unescaped; bare tokens are taken as-is.
 */
export function parseBearerChallenge(header: string | null | undefined):
  | {
      scope?: string;
      error?: string;
      errorDescription?: string;
      resourceMetadata?: string;
    }
  | undefined {
  if (!header) return undefined;
  const match = /(?:^|,)\s*Bearer(?=\s|$)([^]*)/i.exec(header);
  if (!match) return undefined;
  const params: Record<string, string> = {};
  const paramRe = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let m: RegExpExecArray | null;
  while ((m = paramRe.exec(match[1] ?? '')) !== null) {
    const key = (m[1] ?? '').toLowerCase();
    const value = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : (m[3] ?? '');
    // A second challenge scheme (e.g. `, Basic realm=...`) would show up as a bare
    // `scheme` token without `=`; the regex skips it since it requires `=`.
    if (!(key in params)) params[key] = value;
  }
  return {
    ...(params.scope ? { scope: params.scope } : {}),
    ...(params.error ? { error: params.error } : {}),
    ...(params.error_description ? { errorDescription: params.error_description } : {}),
    ...(params.resource_metadata ? { resourceMetadata: params.resource_metadata } : {}),
  };
}
