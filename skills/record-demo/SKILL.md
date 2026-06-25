---
name: record-demo
description: Record or regenerate the mcpc demo GIFs (the README hero docs/images/mcpc-demo.gif and the focused tapes in docs/vhs/) with VHS. Use whenever asked to create, refresh, restyle, shorten, or fix a terminal demo/animation/GIF of mcpc. The tapes drive real mcpc commands; for the authenticated step this skill ALWAYS prompts for a short-lived, low-permission TEST token first (never production). Captures the VHS + mcpc gotchas learned the hard way — read it fully before editing a tape.
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
---

# record-demo: VHS demo GIFs for mcpc

The tapes in `docs/vhs/*.tape` are [VHS](https://github.com/charmbracelet/vhs)
scripts that drive a **real** shell session — VHS types each command, runs it
against a live MCP server, captures the terminal, and renders a GIF. The README
hero is `docs/images/mcpc-demo.gif`, built from `docs/vhs/mcpc-demo.tape`.

This file is the accumulated know-how. **Read all of it before touching a tape**
— most rules below were discovered by hitting the wall, and skipping them wastes
whole render cycles (~1–2 min each).

## The hero flow (`mcpc-demo.tape`)

A basic-use story across both transports:

1. `mcpc` — empty state (no sessions, no profiles)
2. `mcpc connect mcp.json:filesystem` — local **stdio** server (auto-names `@filesystem`)
3. `mcpc` — session list (now shows the live session)
4. `mcpc @filesystem tools-list`
5. `mcpc @filesystem tools-list --json` — JSON output, syntax-highlighted, no jq
6. `mcpc connect mcp.apify.com -H "Authorization: Bearer $APIFY_TOKEN"` — remote **HTTP** server (auto-names `@apify`)
7. `mcpc @apify tools-list`
8. `mcpc @apify tools-get search-actors` — inspect one tool's input schema
9. `mcpc @apify tools-call search-actors keywords:="web scraper" limit:=3`
10. `mcpc @apify close`

Ten commands run ~45s; there is no hard 30s cap for this flow.

## Style conventions (the current standard — match these)

- **No `# comments`** in the visible script. The commands are self-descriptive.
- **No `| head`, no `2>/dev/null`** on visible commands. Show real output even if
  long — it scrolls naturally. (`connect` ≈ 86 lines incl. an "Available commands"
  list, `tools-call search-actors` ≈ 56, filesystem `tools-list --json` ≈ 300.)
- **Continuous session — never `clear` between steps.** Put a single blank-line
  `Enter` before each command (after the first) so it's separated from the
  previous output, like a real terminal session.
- **Colored prompt + bold-white typed commands.** In the hidden setup block:
  ```
  Type 'export PS1="\[\e[1;38;2;25;230;77m\]$\[\e[0m\] \[\e[1;97m\]"'
  Enter
  Type "trap 'tput sgr0' DEBUG"
  Enter
  ```
  - `PS1` is a bold bright-green `$`, then ends with `\[\e[1;97m\]` so the typed
    input renders bold bright-white.
  - The `DEBUG` trap runs `tput sgr0` before every command so the bold-white
    input does **not** bleed into command output.
- **Empty state** needs a clean home — hidden: `Type 'export MCPC_HOME_DIR="$(mktemp -d)"'`
  so `mcpc` shows "No active MCP sessions / No OAuth profiles".
- **Color is automatic for non-piped commands** — mcpc detects the TTY and emits
  color (256-color, plenty vivid). You only need `export FORCE_COLOR=3`
  (+ `COLORTERM=truecolor` for exact hex) when a command is **piped** (mcpc turns
  color off when stdout isn't a TTY). The current tapes avoid pipes, so they don't
  need it. (The CLI palette lives in `src/cli/output.ts`, `RAINBOW_SATURATION`,
  bumped to 78% for vividness — that's where the demo colors come from.)

## VHS gotchas (these will bite you)

- **ASCII prompt symbols only.** Multibyte glyphs (`❯`, `»`, `▶`) break bash prompt
  rendering under VHS and show up as garbage like `92m]`. Use `$` (or `>`), styled
  with color + bold.
- **`Type` quoting:** use **single quotes** around any command containing double
  quotes. A `\"` inside a double-quoted `Type` breaks VHS's parser. e.g.
  `Type 'mcpc @apify tools-call search-actors keywords:="web scraper" limit:=3'`
  and `Type 'export PS1="\[\e[…m\]$\[\e[0m\] "'`.
- **Output/Screenshot paths:** must not start with a digit (`Output 1-foo.gif`
  fails to parse) and must not be long absolute paths (the parser chokes). Use
  short, letter-leading, **relative** names and run `vhs` from `docs/vhs/`.
- **`Screenshot` is unreliable** (frequently exits 2 even though the GIF rendered
  fine). Don't depend on it — pull frames from the finished GIF instead:
  `ffmpeg -y -ss <seconds> -i x.gif -vframes 1 frame.png`, then Read the PNG.
- **Renders are slow** (~1–2 min each: real-time timeline + Chromium + ffmpeg
  encode). Render tapes **one at a time** — a `for` loop over several blows the
  5-minute command timeout. Extracted frames often land mid-typing; sample a few
  timestamps around when output should be on screen.
- **Hidden connects leak into the recording if bash falls behind.** When a tape
  connects in the hidden setup (so the feature commands run against a ready
  session, e.g. tools/scripting/grep), a slow connect lets VHS type ahead; bash
  then echoes the buffered commands and runs the `clear` *after* `Show`, so the
  setup spills into frame. Pattern that works: type the connect(s), then **one
  generous `Sleep` (7–8s)** so they finish, then `clear`, then **another `Sleep`
  (~1.5s) before `Show`**. (Tapes that connect *visibly* as their first command
  don't need this — their hidden setup is just fast exports + `clear`.)

## Stdio servers in a headless / proxied box

- **`npx`-launched stdio servers are too slow here.** `npx -y <pkg>`'s registry
  round-trip exceeds mcpc's 60s connect handshake, so `connect` times out
  (`MCP error -32001`). Fixes: pre-install the server (`npm i -g <pkg>`) and put
  the **direct binary** in `mcp.json` (e.g. `mcp-server-filesystem`, starts in
  ~0.3s — also a cleaner session header), or use `npx --prefer-offline -y <pkg>`
  once the npm cache is warm (~5s; plain `npx -y` still does the slow registry
  check even when cached).
- **Puppeteer does NOT work for headless recording.**
  `@modelcontextprotocol/server-puppeteer` launches Chromium eagerly on startup
  and hangs/times out as root in the container. Use
  **`@modelcontextprotocol/server-filesystem`** instead (14 recognizable tools,
  instant). `docs/vhs/mcp.json` defines the `filesystem` entry via its global
  binary — install it first: `npm i -g @modelcontextprotocol/server-filesystem`.

## Auth token (the authenticated step)

- **Always prompt for the token first.** Insist on a **short-lived,
  low-permission token from a TEST / throwaway account — never production.**
  Apify: <https://console.apify.com/settings/integrations>. Tell the user to
  **revoke it as soon as the recording is done.**
- Pass it inline, for the render only: `APIFY_TOKEN=… vhs mcpc-demo.tape`. The
  tape references `$APIFY_TOKEN` (never the literal), typed inside **single
  quotes** so bash expands it at run time — the value is **never on screen, never
  in the GIF, never committed**. Always verify a connect frame shows
  `$APIFY_TOKEN`, not the value.
- `connect` **auto-names** the session: `mcp.apify.com → @apify`,
  `mcp.json:filesystem → @filesystem`. No `@name` needed.
- No-token alternative (public, anonymous): `mcpc connect "https://mcp.apify.com/?tools=search-actors,fetch-actor-details,docs"`.

## Keychain warning (headless only)

On a box with no keyring, the bearer-token `connect` prints
`[keychain] OS keychain unavailable, falling back to file-based credential
storage …`. It is **environment-specific** (won't appear on a normal desktop
with a keyring) and there is **no env var to suppress it** — it's a `logger.warn`
in `src/lib/auth/keychain.ts` gated only by keychain availability and JSON mode.
A `dbus-run-session` + `gnome-keyring-daemon` wrapper does **not** fix it in this
sandbox (raising the dbus fd limit is blocked). Options: leave it (honest), or add
a targeted `2>/dev/null` to just that one connect command.

## Prerequisites

```bash
mcpc --version            # the CLI being demoed (npm i -g @apify/mcpc, or build + pnpm link this repo)
vhs --version             # brew install vhs (needs ttyd + ffmpeg on PATH)
mcp-server-filesystem     # npm i -g @modelcontextprotocol/server-filesystem (the stdio demo server)
```

Headless + **root**: VHS drives a Chromium (go-rod auto-downloads it to
`~/.cache/rod`) that refuses to start without `--no-sandbox`. If renders fail to
launch Chromium, wrap the binary once:

```bash
CHROME=$(find ~/.cache/rod/browser -name chrome -type f | head -1)
mv "$CHROME" "$CHROME-real"
printf '#!/bin/sh\nexec "$(dirname "$0")/chrome-real" --no-sandbox --disable-gpu --disable-dev-shm-usage "$@"\n' > "$CHROME"
chmod +x "$CHROME"
```

(Run `vhs` once first to trigger the Chromium download.)

## Render and verify

```bash
cd docs/vhs
APIFY_TOKEN=…   vhs mcpc-demo.tape                                   # real-time; be patient
ffprobe -v error -show_entries format=duration -of csv=p=0 mcpc-demo.gif   # check length
ffmpeg -y -ss 12 -i mcpc-demo.gif -vframes 1 /tmp/f.png             # spot-check a frame, then Read it
cp mcpc-demo.gif ../images/mcpc-demo.gif                            # update the README hero
```

Check each frame class: empty state, stdio connect + session list, tools-list,
JSON, remote connect (**token NOT visible**), tool-call result, close. Then
**revoke the token.**

## Optimize the GIF size (do this before committing)

VHS GIFs are large (the hero is ~5 MB raw). Shrink them losslessly-ish with
`gifsicle` ([kornel.ski/lossygif](https://kornel.ski/lossygif)) — `--lossy`
drops imperceptible inter-frame detail and **cuts ~60%** off a text-terminal GIF
with no visible quality loss:

```bash
# in place; lossy=200 ≈ 60% smaller, text stays crisp (verified by frame diff)
for f in docs/images/mcpc-demo.gif docs/vhs/*.gif; do
  [ "$f" = docs/vhs/mcpc-demo.gif ] && continue   # ignored raw hero
  gifsicle -O3 --lossy=200 -b "$f"
done
```

After optimizing, re-extract a colored frame (`ffmpeg -ss 12 …`) and eyeball it —
lossy=200 is the sweet spot; going much higher smears the antialiased text.
When the optimized hero lands on `main`, **bump the README cache-buster**
(`mcpc-demo.gif?v=N` → `?v=N+1`): GitHub's camo image proxy caches by full URL,
so a new `?v=` is what makes it re-fetch the smaller file instead of serving the
old cached copy.

## What's committed

- `docs/images/mcpc-demo.gif` — the README hero (canonical copy).
- `docs/vhs/*.gif` — the per-feature recordings are committed too, so they're easy
  to find and reuse. `.gitignore` ignores only `docs/vhs/mcpc-demo.gif` (the hero's
  raw output, since it's committed under `docs/images/`).
- `proxy.gif` needs a token to record and isn't committed until recorded.

## The tapes

| Tape | Records |
| ---- | ------- |
| `mcpc-demo.tape` | Hero basic-use flow (stdio + remote) → `docs/images/mcpc-demo.gif` |
| `quickstart.tape` | Minimal connect → list → call |
| `tools.tape` | `tools-list` / `tools-get` / `tools-call`, inline JSON, stdin |
| `scripting.tape` | `--json` piped through `jq` (code mode) |
| `grep.tape` | Dynamic tool discovery with `mcpc grep` across two sessions (Apify + filesystem) |
| `proxy.tape` | MCP proxy / AI sandboxing (keeps a bearer token on purpose) |

All focused tapes follow the same conventions as the hero (bold `$` prompt,
bold-white commands, no comments, blank-line separation, `mktemp` home).
`quickstart`/`tools`/`scripting`/`grep` are token-free (public `?tools=` URL);
`grep` also connects a local filesystem stdio server so it can search across two
sessions. `proxy.tape` keeps a bearer token because demonstrating that you can
proxy a credentialed session without leaking the token is its entire point (it's
the one focused tape that needs a token to record).
