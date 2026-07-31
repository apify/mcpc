# MCP conformance tests

These tests run the reference [`@modelcontextprotocol/conformance`](https://github.com/modelcontextprotocol/conformance)
suite against mcpc. The framework starts a purpose-built server per scenario,
runs `client.mjs` (the adapter) against it, and records checks based on what the
server observed on the wire. It tests mcpc as a real user drives it — the
adapter only ever invokes the `mcpc` binary.

Run one scenario locally:

```bash
pnpm run build
npx -y @modelcontextprotocol/conformance client \
  --command "node test/conformance/client.mjs" \
  --scenario auth/client-credentials-basic \
  --timeout 180000
```

List everything the framework offers with
`npx -y @modelcontextprotocol/conformance list --client`.

In CI the scenarios run via `.github/workflows/conformance.yml`, which the
release workflow depends on — a conformance regression blocks a release.

## Keeping these in sync

**Conformance scenarios are part of the test surface, like the e2e suites.**
When a change touches protocol behaviour, the OAuth flows, or transport
handling, check whether a scenario covers it and update the adapter in the same
PR — the same rule that applies to `test/e2e`. Two failure modes to avoid:

- A deliberate behaviour change breaks the adapter, and the break is only
  discovered when a release is gated (this happened in #329/#331).
- A new feature ships with a scenario already available upstream and nobody
  wires it up.

When upgrading the conformance package, re-run `list --client` and check for
newly added scenarios.

## Covered

| Scenario | What it pins down |
| --- | --- |
| `initialize` | Handshake, then the list-style commands against a minimal server |
| `tools_call` | `tools-list`/`tools-get`/`tools-call` argument-parsing paths; `--task` is refused when the server has no `tasks` capability |
| `auth/client-credentials-basic` | `login --grant client-credentials` with `client_secret_basic`, incl. RFC 9728 discovery of an authorization server on another origin |
| `auth/client-credentials-jwt` | The same via `private_key_jwt` (`--client-key`), signed with ES256 |

`sse-retry` is implemented but excluded from default runs: it surfaces a known
mcpc SSE-reconnect timing issue. Run it explicitly with
`gh workflow run conformance.yml -f scenario=sse-retry`.

## Not covered yet

The interactive `auth/*` scenarios — metadata discovery variants, CIMD, scope
selection and step-up, token-endpoint auth methods, pre-registration,
2025-03-26 backcompat, and the SEP-990 cross-app-access flow — all drive the
authorization-code grant, which opens a browser. Supporting them needs the
adapter to intercept the browser launch and complete the redirect itself; the
non-interactive client-credentials scenarios above were wired up first because
they need no such scaffolding.

`elicitation-sep1034-client-defaults` is intentionally out of scope: mcpc
implements no elicitation (it never prompts for input, the same reason sampling
is unsupported).

Note that the framework's client scenarios currently top out at protocol
`2025-11-25`, so these runs exercise mcpc's legacy fallback path rather than the
`2026-07-28` era it negotiates by default.
