# mcpc demo recordings (VHS)

This folder contains [VHS](https://github.com/charmbracelet/vhs) tape files that
record terminal GIFs of mcpc. Each `.tape` drives a **real** shell session; VHS
replays it, runs the commands against a live MCP server, and renders a GIF.

> **Recording or editing a tape? Read
> [`skills/record-demo`](../../skills/record-demo/SKILL.md) first.** It documents
> the full conventions and the VHS + mcpc gotchas learned the hard way — prompt
> styling, multibyte-glyph breakage, stdio-server quirks, secure token handling,
> the headless keychain warning, and how to verify frames.

## Prerequisites

- **VHS** — `brew install vhs` (needs `ttyd` + `ffmpeg` on PATH)
- **mcpc** — `npm install -g @apify/mcpc`
- **filesystem MCP server** — `npm install -g @modelcontextprotocol/server-filesystem`
  (the local stdio server `mcpc-demo.tape` launches via `mcp.json`)
- **jq** — used by `scripting.tape`
- **`APIFY_TOKEN`** — a **short-lived, low-permission TEST token** for the hero's
  authenticated step (see the skill); pass it inline at render time. The focused
  tapes use the public no-auth `?tools=` URL and need no token.

## Tapes

| File | Records | Notes |
| ---- | ------- | ----- |
| [`mcpc-demo.tape`](./mcpc-demo.tape) | Basic-use flow: empty state → connect local stdio (`mcp.json:filesystem`) → `tools-list` / `--json` / `tools-get` → connect `mcp.apify.com` → `tools-call` → close | Source of `docs/images/mcpc-demo.gif` |
| [`quickstart.tape`](./quickstart.tape) | Minimal connect → list → call | |
| [`tools.tape`](./tools.tape) | `tools-list` / `tools-get` / `tools-call`, inline JSON, stdin | |
| [`scripting.tape`](./scripting.tape) | `--json` piped through `jq` (code mode) | |
| [`grep.tape`](./grep.tape) | `mcpc grep` across two sessions (Apify + local filesystem) | |
| [`proxy.tape`](./proxy.tape) | MCP proxy / AI sandboxing (keeps a bearer token on purpose) | |

## Recording

Run from inside `docs/vhs/`:

```bash
cd docs/vhs
APIFY_TOKEN=…  vhs mcpc-demo.tape     # hero (needs the test token)
vhs quickstart.tape                   # focused tapes (no token)

# verify before committing (Screenshot is unreliable — extract frames instead):
ffprobe -v error -show_entries format=duration -of csv=p=0 mcpc-demo.gif
ffmpeg -y -ss 12 -i mcpc-demo.gif -vframes 1 /tmp/frame.png

cp mcpc-demo.gif ../images/mcpc-demo.gif   # refresh the README hero

# shrink ~60% with no visible quality loss before committing:
gifsicle -O3 --lossy=200 -b ../images/mcpc-demo.gif *.gif
```

## Style conventions

- **No `# comments`** (commands are self-descriptive) and **no `| head` /
  `2>/dev/null`** on visible commands — show real output, even if it scrolls.
- **Continuous session — never `clear` between steps;** a single blank-line
  `Enter` before each command separates it from the previous output.
- **Bold bright-green `$` prompt + bold-white typed commands**, set via `PS1`
  plus a `tput sgr0` DEBUG trap in the hidden setup. **ASCII prompt symbols
  only** — multibyte glyphs (`❯`, `»`) break under VHS.
- `mcpc-demo.tape` uses `export MCPC_HOME_DIR="$(mktemp -d)"` (hidden) so the
  first `mcpc` shows a clean empty state.

The exact `PS1` string, the reasoning, and every other gotcha live in the skill.

## What's committed

- `docs/images/mcpc-demo.gif` — the README hero.
- `docs/vhs/*.gif` — per-feature recordings are committed too, so they're easy to
  find and reuse. `.gitignore` ignores only `docs/vhs/mcpc-demo.gif` (the hero's
  raw output, committed under `docs/images/`). `proxy.gif` needs a token to record.

See the [VHS documentation](https://github.com/charmbracelet/vhs#vhs-command-reference)
for the full directive reference.
