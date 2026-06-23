---
name: record-demo
description: Record or regenerate the mcpc demo GIFs (the README hero and the focused tapes in docs/vhs/) using VHS. Use this whenever asked to create, refresh, or shorten a terminal demo/animation/GIF of mcpc. The demos drive real mcpc commands against a live MCP server, so this skill ALWAYS prompts for any API token first and insists on a short-lived token from a throwaway/test account — never a production one.
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
---

# record-demo: VHS demo GIFs for mcpc

The tapes in `docs/vhs/*.tape` are [VHS](https://github.com/charmbracelet/vhs)
scripts that drive a **real** shell session — VHS types the commands, runs them
against a live MCP server, captures the terminal, and renders a GIF. The README
hero is `docs/images/mcpc-demo.gif`, built from `docs/vhs/mcpc-demo.tape`.

Because the commands run for real, recording a demo against an authenticated
server (such as `mcp.apify.com`) needs a real credential. **Step 1 is always to
prompt for that token — securely.**

## 1. Prompt for API tokens FIRST (required)

Before touching a tape that connects to an authenticated server, use
`AskUserQuestion` to ask the user to supply the token, and make the safety rules
explicit. **Do not skip this and do not reuse a token you happen to find in the
environment without confirming it is safe to use.**

Tell the user to:

- **Create a brand-new token just for this recording** — don't reuse an existing one.
- **Use a testing / throwaway account, never a production account.** Demos can be
  re-recorded many times and the token lives in a recorded shell + a background
  bridge process; a test account keeps the blast radius near zero.
- **Set the shortest expiration the provider allows** (e.g. an hour or a day).
- **Revoke the token as soon as the recording is done.**

For the Apify server, point them at <https://console.apify.com/settings/integrations>
to mint a scoped, short-lived **test** token.

How the token is handed over and kept safe:

- The user provides it as an environment variable that VHS inherits, e.g.
  `export APIFY_TOKEN=apify_api_...`. Prompt with `AskUserQuestion`; if they
  paste it, `export` it for the render only.
- **Tapes reference the variable, never the literal token** — e.g.
  `-H "Authorization: Bearer $APIFY_TOKEN"`. The shell expands it at run time, so
  the secret is **never typed on screen, never in the GIF, never committed.**
- Never `echo`, log, or print the token. Never hard-code it in a tape. Confirm
  it's a non-production token before recording.
- To record against a **public** server instead, drop the `-H` line from the tape
  and skip this step entirely.

## 2. Prerequisites

```bash
mcpc --version        # the CLI being demoed (npm i -g @apify/mcpc, or build + link this repo)
vhs --version         # brew install vhs  — needs ttyd + ffmpeg on PATH
jq --version          # used by the code-mode / scripting tapes
```

On a headless Linux box or container, VHS drives a Chromium that go-rod
auto-downloads to `~/.cache/rod`. Running **as root** it refuses to start without
`--no-sandbox`. Wrap the downloaded binary once:

```bash
CHROME=$(find ~/.cache/rod/browser -name chrome -type f | head -1)
mv "$CHROME" "$CHROME-real"
printf '#!/bin/sh\nexec "$(dirname "$0")/chrome-real" --no-sandbox --disable-gpu --disable-dev-shm-usage "$@"\n' > "$CHROME"
chmod +x "$CHROME"
```

(`vhs` first runs without it just to trigger the Chromium download.)

## 3. Keep it under 30 seconds (basic interactions)

The hero demo should show the core loop and nothing more: **connect → list tools
→ call a tool → `--json` for code mode → close**. Pacing knobs in the `Set` block:

- `Set TypingSpeed 45ms`, short `Sleep` after each command (≈2.5–3.5s to read output).
- `Set Framerate 24` keeps the GIF small; `Set PlaybackSpeed 1.2` shaves the final
  duration if you run over budget.
- `Hide` / `Show` around setup (`export PS1='$ '`, closing stale sessions, `clear`)
  so it stays off-screen.

VHS records in **real time**: a ~30s tape takes ~30s to record, plus Chromium
startup and ffmpeg encode — give renders a few minutes, not seconds.

## 4. Record and verify

```bash
cd docs/vhs
export APIFY_TOKEN=...                       # the short-lived TEST token from step 1
vhs mcpc-demo.tape                            # → mcpc-demo.gif (real-time; be patient)

# Confirm the 30-second budget BEFORE committing:
ffprobe -v error -show_entries format=duration \
  -of default=noprint_wrappers=1:nokey=1 mcpc-demo.gif

cp mcpc-demo.gif ../images/mcpc-demo.gif      # update the README hero
```

Open the GIF and check: the prompt is clean, the token is **not** visible
anywhere, output is readable, and total length ≤ 30s. Then **revoke the token.**

Only `docs/images/mcpc-demo.gif` is committed; the other tapes' GIFs are generated
on demand and stay out of git.

## 5. The tapes

| Tape | Records |
| ---- | ------- |
| `mcpc-demo.tape` | Hero ≤30s overview: connect → tools → call → `--json` → close (source of `docs/images/mcpc-demo.gif`) |
| `quickstart.tape` | Minimal connect → list → call |
| `tools.tape` | `tools-list` / `tools-get` / `tools-call`, inline JSON, stdin |
| `scripting.tape` | `--json` piped through `jq` (code mode) |
| `grep.tape` | Dynamic tool discovery with `mcpc grep` |
| `proxy.tape` | MCP proxy / AI sandboxing |

Copy the `Set` block between tapes so they look consistent. See
[`docs/vhs/README.md`](../../docs/vhs/README.md) for the full directive reference.
