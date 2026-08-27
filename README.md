# PromptConduit

**See what each AI prompt costs** — computed entirely on your machine. One click
from the status bar opens a per-prompt cost ledger with coaching tips and
optional branch/PR scopes. Everything reads your local event log
(`~/.promptconduit/events.jsonl`); none of your code or prompts leave your device.

## Install

**Cursor** — open the Extensions pane (`⇧⌘X` / `Ctrl+Shift+X`), search
**"PromptConduit"**, and click **Install**. Cursor installs from
[Open VSX](https://open-vsx.org/extension/promptconduit/promptconduit).

**VS Code** — a Marketplace listing is on the way. Until then, build the `.vsix`
locally (see [Publishing](#publishing)) and install it with
`code --install-extension promptconduit-<version>.vsix`.

The extension drives the `promptconduit` CLI, so install that too — see
[Requirements](#requirements).

## Screenshots

**AI Cost Breakdown** — per-prompt ledger, one coaching tip up front, Session /
This branch / This PR scope chips. Raw JSON and what-if comparisons live in an
Advanced drawer.

![AI Cost Breakdown panel in Cursor](https://raw.githubusercontent.com/promptconduit/editor-extension/main/resources/screenshots/cost-breakdown-window.png)

**Session Graph** — a live tree of prompts, tools, subagents, and worktrees
(command palette: *PromptConduit: Show Session Graph*).

![Session Graph panel in Cursor](https://raw.githubusercontent.com/promptconduit/editor-extension/main/resources/screenshots/graph-window.png)

**Stream** — a live event feed (command palette: *PromptConduit: Show Stream Panel*).

![Stream panel in Cursor](https://raw.githubusercontent.com/promptconduit/editor-extension/main/resources/screenshots/stream-window.png)

**Orchestration Theater** — a 3D replay of sub-agents spawning and tool calls
fanning out (command palette: *PromptConduit: Show Orchestration Theater*).

![Orchestration Theater panel in Cursor](https://raw.githubusercontent.com/promptconduit/editor-extension/main/resources/screenshots/orchestration-theater-window.png)

**Agent Coaching** — an offline report on how you drive the agent (command palette:
*PromptConduit: Show Agent Coaching*).

![Agent Coaching panel in Cursor](https://raw.githubusercontent.com/promptconduit/editor-extension/main/resources/screenshots/agent-coaching-window.png)

## Realtime token cost

The bottom-right status bar shows `⚡ <request cost> · 🕘 <session cost>`. Click
it for the **AI Cost Breakdown** panel.

## The AI Cost Breakdown panel

The breakdown estimates what your session would cost at **pay-as-you-go API
rates** — useful whether you're on a subscription or paying per token.

- **Cost per prompt** — every prompt as a row with a relative-cost bar. Expand
  for model, tokens, and cache stats.
- **Do better** — one actionable coaching tip for the session.
- **Scope chips** — Session, **This branch** (your current feature branch), or
  **This PR** (when `gh` has resolved an open PR on the branch).
- **Advanced** (collapsed) — what-if model comparison, by-model table, raw event
  JSON, and learn-more links.

Works for **Claude Code** and **Cursor**.

## More surfaces

All available from the command palette (`⇧⌘P`):

| Command | What it does |
|---------|----------------|
| Show Cost Breakdown | Per-prompt ledger (also via status bar) |
| Show Stream Panel | Live event feed |
| Show Session Graph | 2D tree of turns, tools, subagents |
| Show Orchestration Theater | 3D replay of agent orchestration |
| Show Agent Coaching | Offline coaching report |
| Show All Sessions Cost | Multi-session overview |

## How it works

The extension tails `~/.promptconduit/events.jsonl` (written by the
`promptconduit` CLI hooks) and prices each turn against a bundled rate table.
See `cli/internal/cost` for the pricing engine.

## Requirements

Install the CLI:

```bash
curl -fsSL https://promptconduit.dev/install | bash
```

If it isn't on your `PATH`, set `promptconduit.cost.binaryPath`.

## Settings

| Setting | Default | Description |
|---|---|---|
| `promptconduit.cost.enabled` | `true` | Show the realtime token-cost item in the status bar. |
| `promptconduit.cost.binaryPath` | `""` | Override the CLI path (auto-detected otherwise). |

## Develop

```bash
npm install
npm run compile        # or: npm run watch
```

Press **F5** in VS Code / Cursor to launch an Extension Development Host, open a
folder where you run Claude Code or Cursor agent, and watch the status bar update.

## Publishing

Targets: **Open VSX** (for Cursor) and the **VS Code Marketplace**.

Release: bump `version` in `package.json`, commit, then tag — the `Publish`
workflow publishes to Open VSX automatically:

```bash
git tag v0.21.0 && git push origin v0.21.0
```

Or publish locally:

```bash
npm run package        # builds promptconduit-<version>.vsix
npm run publish:ovsx   # needs OVSX_TOKEN in env or `ovsx login`
npm run publish:vsce   # needs `vsce login promptconduit`
```
