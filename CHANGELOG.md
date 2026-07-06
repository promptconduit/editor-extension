# Changelog

## 0.13.0

- **Focus-aware cost breakdown (Epic 5).** The status bar and default cost
  panel follow the **focused terminal's Claude Code session** (via new CLI
  `sessions resolve --pid`), a **manual pin**, or debounced feed activity for
  Cursor. Click the cost item for a **single-session** breakdown; use the new
  `$(list-tree) All sessions` status-bar button for the multi-session overview.
- **Pin / follow** commands for cost (`promptconduit.cost.pinSession`,
  `promptconduit.cost.followActive`) mirror the Stream panel pattern.
- Requires CLI with `sessions resolve` (cli ≥ next release after 0.x).

## 0.12.1

- **Accurate per-session request count.** The AI Cost Breakdown no longer caps a
  session's history at 50 requests, so the header shows the true count and no
  prompt is dropped from the data. The per-prompt list renders the newest 100
  rows (with a "+N older prompts not shown" note) to keep the panel responsive;
  full history remains in `~/.promptconduit/events.jsonl`.

## 0.12.0

- **Envelope v2 — one file, one schema (breaking).** Every surface now reads
  the CLI's v2 envelopes from `~/.promptconduit/events.jsonl`: per-request cost
  arrives as the `cost` enrichment on Stop events, so the
  `promptconduit cost watch --json` subprocess (and its separate wire schema)
  is gone. Requires CLI ≥ 0.9 (envelope v2); pre-v2 log lines are skipped.
- **Multi-session AI Cost Breakdown.** The breakdown panel now covers EVERY
  tracked session — Claude Code and Cursor side by side. The hero sums the
  counterfactual API cost across sessions; a new **By session** section lists
  each one (tool badge, workspace, request count, total) with expandable
  per-prompt rows and per-model tables. Session totals are accumulated locally
  and survive editor restarts (bounded history read on startup).
- **Panels moved to editor tabs.** The bottom-panel "PromptConduit" container
  is gone. **Stream** (now with a Repo column — the old Telemetry view is
  folded in) and **Agent Coaching** open as editor tabs like the Cost
  Breakdown; Stream's pin/follow moved into in-panel links, and the `$(pulse)
  Stream` status-bar button remains the entry point.
- Stream rows show `repo @ branch` from the envelope's `vcs` enrichment
  (normalized provider/repo/PR links computed by the CLI).

## 0.11.0

- **Bottom-right "Stream" button.** A new `$(pulse) Stream` item in the status
  bar opens the live **Stream** panel with one click — a per-session, human-readable
  tail of `~/.promptconduit/events.jsonl` that auto-follows the most recently active
  AI session (Cursor agent tab or Claude Code) and can be pinned to one. The panel
  itself shipped earlier; this adds the discoverable entry point next to the cost item.

<!-- 0.7.0–0.10.0 were internal/unreleased; see git history. -->

## 0.6.0

- **Now just "PromptConduit."** The extension is rebranded from
  *PromptConduit — Realtime Token Cost* to the umbrella **PromptConduit** as it
  grows beyond cost into a suite of local, in-editor surfaces over your AI
  sessions. Realtime cost remains; your `promptconduit.cost.*` settings and
  commands are unchanged.
- **Orchestration Theater** — a new 3D visualization (command:
  *PromptConduit: Show Orchestration Theater*) that cinematically replays your
  local session log: a lead agent spawning sub-agents, tool calls beaming out to
  fetch URLs / read-write local files / hit cloud APIs, and hover cards linking
  the GitHub issue and PR behind each node. Reads `~/.promptconduit/events.jsonl`
  and runs entirely on your machine.
- Optional GitHub enrichment fetches issue/PR titles and status to enrich hover
  cards. It sends only `owner/repo/number` for the current repo (never your code
  or prompts) and can be set to infer-only or disabled via
  `promptconduit.visualizer.githubEnrichment`.

## 0.5.1

- **Leaner package**: the published VSIX no longer ships development-only files
  (`dev/`, `test/`, `docs/`, `scripts/`, `.vscode/`, `*.config.ts`,
  `DEVELOPING.md`, `CONTRIBUTING.md`, source maps). It now contains only the
  runtime (`out/`, `resources/`) plus README, changelog, and license — smaller
  download, cleaner listing. No functional change.

## 0.5.0

- **AI Cost Breakdown — reframed around the API equivalent.** The breakdown
  panel now leads with what the session *would* cost at pay-as-you-go API rates —
  "this is what the same tokens would bill à la carte" — so subscription users
  can see the value their plan covers (#33).
- **Cost per prompt, at a glance.** Each request is a row with a relative-cost
  bar, so the prompts that drove spend stand out; click any row for its token
  split, cache-hit rate, and tools.
- **"What's driving your cost"** — a scannable, color-coded readout of cache-hit
  rate, fresh-input share, model tier, and tool-call volume.
- **Educational by design.** Cost-reduction tips and the new **Learn more**
  section link the official Claude *and* Cursor docs (API pricing, prompt
  caching, reduce-token-usage). Links are tool-aware — the active assistant's
  docs come first, but both are always shown.
- **Edge cases, explained with a fix.** A "Reading these numbers" section
  surfaces unpriced models, estimated vs. exact counts, and the
  subscription-vs-API framing, each with a concrete resolution.
- The zero-state landing now carries the same educational links and framing.

## 0.4.0

- **Tab-aware cost**: the status bar now follows the most-recently-active agent
  tab. Cost is tracked per conversation (Cursor's per-tab `conversation_id`,
  falling back to `session_id` for Claude Code), and the bar, tooltip, and
  breakdown panel all reflect whichever tab produced the latest turn (#7).
- **Zero-state landing**: a fresh or unseen tab now shows `$0.00` and, on click,
  a landing view — what PromptConduit is, the 100%-local privacy promise, a
  "how cost tracking works" blurb, **Learn more** links, and a Pro/Team
  overview — instead of an empty table (#8, #9, #10, #11).

## 0.3.0

- The status-bar hover tooltip now surfaces the session's cost-reduction signals
  (cache-hit rate, model tier, tool-call volume) inline.
- Added a docked **Telemetry** panel in the editor's bottom panel — a live tail
  of the local `events.jsonl` feed.

## 0.2.0

- Upgraded to cost-feed **schema v2**: the breakdown now shows a per-request
  drill-down (tools called, token split, and per-request cost) and a
  **"Reduce your cost"** section with actionable tips derived from the CLI's
  cost-reduction signals (cache-hit rate, fresh-input share, model tier,
  tool-call volume).
- **Forward-compatible parser**: the extension now accepts any cost record with
  `v >= 1` and reads fields defensively (the cost-feed contract is
  additive-only), so a newer auto-updated CLI never blanks the panel.
- Carries Cursor's `conversation_id` through for upcoming per-tab cost.

## 0.1.0

- Initial release. Realtime token-cost in the editor status bar — request cost
  and session cost — with a click-through webview breakdown (per-model;
  input / output / cache-read / cache-write tokens).
- Works for **Claude Code** and **Cursor**, driven by the `promptconduit cost
  watch --json` stream. 100% local — no data leaves the machine.
- Models without a known rate (e.g. Cursor's `composer-*`) show exact tokens,
  labeled "unpriced," instead of a misleading `$0.00`.
