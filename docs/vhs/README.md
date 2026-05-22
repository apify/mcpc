# mcpc demo recordings (VHS)

This folder contains [VHS](https://github.com/charmbracelet/vhs) tape files
that record terminal GIFs of mcpc. Each `.tape` is a small script that drives
a real shell session; VHS replays it, captures the output, and renders a GIF
(or MP4 / WebM) — no manual screen recording needed.

## Prerequisites

- **VHS** — `brew install vhs` (or see [installation guide](https://github.com/charmbracelet/vhs#installation))
- **mcpc** — `npm install -g @apify/mcpc`
- **jq** — needed by `scripting.tape`
- **Auth (optional)** — `export APIFY_TOKEN=...` if you want the demos to hit
  the authenticated Apify MCP server. Drop the `--header` line from the tape
  to record an anonymous session against any public MCP server instead.

## Tapes

| File | Records | Notes |
| ---- | ------- | ----- |
| [`mcpc-demo.tape`](./mcpc-demo.tape) | Flagship overview: discover → connect → tools → grep → call → JSON → close | Source for `docs/images/mcpc-demo.gif` |
| [`quickstart.tape`](./quickstart.tape) | Minimal "connect, list, call" flow | Hero-sized GIF for README top |
| [`tools.tape`](./tools.tape) | `tools-list`, `tools-get`, `tools-call`, inline JSON, stdin | |
| [`scripting.tape`](./scripting.tape) | `--json` piped through `jq` and `xargs` (code mode) | |
| [`grep.tape`](./grep.tape) | Dynamic tool discovery with `mcpc grep` | |
| [`proxy.tape`](./proxy.tape) | MCP proxy / AI sandboxing | |

## Recording

Each tape outputs a GIF in this directory. Run from inside `docs/vhs/`:

```bash
cd docs/vhs
vhs mcpc-demo.tape          # → mcpc-demo.gif
vhs quickstart.tape         # → quickstart.gif
# ... etc
```

To refresh the demo embedded in the main README:

```bash
cd docs/vhs
vhs mcpc-demo.tape
cp mcpc-demo.gif ../images/mcpc-demo.gif
```

You can also render `.mp4` or `.webm` by editing the `Output` directive
inside the tape file (VHS infers the format from the extension).

## Customising

`mcpc-demo.tape` is the template — copy it, trim the sections you don't need,
and adjust:

- `Output <file>` — destination GIF / MP4 / WebM
- `Set Width / Set Height` — frame size (current default: 1100×650)
- `Set FontSize` / `Set FontFamily` / `Set Theme` — appearance
- `Set TypingSpeed` / `Sleep` — pacing
- Server URL and `--header` — point at your own MCP server
- Tool / argument names — swap for tools your audience cares about

The other tapes use the same Set block so they look consistent side by side.

## Tips

- Use `Hide` / `Show` around setup commands (clearing the screen, closing
  stale sessions, exporting `PS1`) so they don't appear in the GIF.
- Add `Sleep` after each `Enter` so viewers have time to read the output
  before the next command runs.
- `Set PlaybackSpeed 1.5` speeds up the final GIF without changing the
  recording cadence — handy for long demos.
- Run the tape locally first (`vhs <file>.tape`) and inspect the generated
  GIF before committing. VHS does not run inside CI by default; the tapes
  are version-controlled but the GIFs they produce are not (the main
  `docs/images/mcpc-demo.gif` is checked in separately).

See the [VHS documentation](https://github.com/charmbracelet/vhs#vhs-command-reference)
for the full list of directives (`Type`, `Sleep`, `Enter`, `Hide`, `Show`,
`Wait`, `Screenshot`, all `Set …` options, etc.).
