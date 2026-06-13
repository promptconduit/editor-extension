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

## Publishing

Targets: **Open VSX** (for Cursor) and the **VS Code Marketplace**.

One-time setup:
1. Push this directory to its own GitHub repo (the `repository` field in
   `package.json` assumes `promptconduit/cost-extension` — update it to match).
2. Create access tokens and add them as repo **secrets**:
   - `OVSX_TOKEN` — Open VSX token from <https://open-vsx.org> (namespace must exist:
     `npx ovsx create-namespace promptconduit`).
   - `VSCE_PAT` — VS Code Marketplace PAT from <https://marketplace.visualstudio.com/manage>
     (create the `promptconduit` publisher first).

Release: bump `version` in `package.json`, commit, then tag — the `Publish`
workflow does the rest:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Or publish locally:

```bash
npm run package        # builds promptconduit-cost-<version>.vsix
npm run publish:ovsx   # needs OVSX_TOKEN in env or `ovsx login`
npm run publish:vsce   # needs `vsce login promptconduit`
```
