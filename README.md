# PromptConduit — Realtime Token Cost

See what your AI coding sessions cost, **live, in the status bar** — computed
entirely on your machine. None of your data leaves your device.

The bottom-right status bar shows `⚡ <request cost> · 🕘 <session cost>`. Click
it for a full breakdown: per-model rows and input / output / cache-read /
cache-write tokens.

## How it works

The extension spawns the `promptconduit` CLI (`promptconduit cost watch --json`)
scoped to your workspace and renders the cost records it streams on stdout. The
CLI reads local AI transcripts, prices each turn against a bundled rate table,
and writes nothing to any server. See `cli/internal/cost` for the engine.

- **Claude Code** — exact token counts straight from the transcript (today).
- **Cursor native agent** — estimate + reconcile (a later milestone).

## Requirements

Install the CLI:

```bash
brew install promptconduit/tap/promptconduit
```

If it isn't on your `PATH`, set `promptconduit.cost.binaryPath`.

## Settings

| Setting | Default | Description |
|---|---|---|
| `promptconduit.cost.enabled` | `true` | Show the status-bar cost item. |
| `promptconduit.cost.binaryPath` | `""` | Override the CLI path (auto-detected otherwise). |

## Develop

```bash
npm install
npm run compile        # or: npm run watch
```

Press **F5** in VS Code / Cursor to launch an Extension Development Host, open a
folder where you run Claude Code, and watch the status bar update as you work.

Publish targets: **Open VSX** (for Cursor) and the **VS Code Marketplace**.
