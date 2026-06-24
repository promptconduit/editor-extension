# SPIKE — Can an extension detect the active Cursor agent/composer tab?

> Epic 2 (Tab-aware running cost) · Issue #6 · branch `spike/cursor-tab-api`
> 100% local · public/MIT · doc only.

## TL;DR — Verdict

**NO.** A VS Code / Cursor extension **cannot** reliably detect the currently-focused
Cursor **agent / composer tab** (or read its `conversation_id`) at runtime.

- Cursor's agent/composer panels are **first-class UI of the fork**, not standard
  editor tabs, so they do not appear in `window.tabGroups` at all.
- Even where an AI surface *did* show up as a webview tab, the VS Code tab API only
  exposes an opaque `viewType` string for webviews — **no `uri`, no `conversation_id`**.
- Cursor exposes **no in-editor / extension-host API** for the focused conversation.
  Its public APIs are server-side (Cloud Agents / Admin / Analytics REST + SDKs).
- Cursor **hooks** carry the identity we need (`conversation_id`, `generation_id`,
  `workspace_roots`) but emit **no focus / tab-switch event** and have no "active tab"
  concept.

**Recommendation:** proceed with the **feed-driven approximation** — treat the
most-recently-active `conversation_id` seen on the cost feed as "the active tab". An
unseen conversation → `$0` + landing page. This is the right call and is **not blocked**
by this spike. Implementation guidance for #7 (2.2) is at the bottom.

---

## What we want vs. what's available

We want the status bar to reflect **the agent/composer tab the user is currently looking
at**. That requires either (a) an API that reports the focused AI surface and its
conversation id, or (b) a runtime event when the user switches AI tabs. Neither exists.

### 1. Standard VS Code tab API (`window.tabGroups`)

The tab API does give an extension a real notion of "active":

- `window.tabGroups.activeTabGroup` → the focused group
- `TabGroup.activeTab` / `Tab.isActive` → the focused tab
- `window.tabGroups.onDidChangeTabs` / `onDidChangeTabGroups` → change events

But two hard limits make it useless for AI tabs:

1. **Webview tabs are opaque.** A webview-backed tab surfaces as `TabInputWebview`,
   which exposes **only `readonly viewType: string` and no `uri`** — there is no way to
   map it to a document, let alone a `conversation_id`. (Contrast `TabInputCustom`, which
   *does* carry `.uri`.) This is a known, acknowledged gap — see VS Code issue
   [#319242](https://github.com/microsoft/vscode/issues/319242): "no public API to map a
   webview tab back to the resource it renders."
2. **Cursor's AI surfaces aren't tabs.** Cursor is a fork of VS Code that re-renders the
   editor surface around AI. The Composer / Agent panels are **first-class fork UI**
   (and, in Cursor 2.0+, a top-level *Agents* view alongside the Editor view), **not**
   extension-contributed webviews or editor tabs. They therefore **do not appear in
   `window.tabGroups`** at all — `activeTab` will only ever reflect normal code/diff/
   webview editor tabs, never the agent panel.

So even in the best case we'd get an opaque `viewType` string; in Cursor's actual case we
get nothing.

### 2. Cursor-specific extension APIs / events

Cursor's documented APIs ([cursor.com/docs/api](https://cursor.com/docs/api)) are all
**server-side**: Admin API, Analytics API, AI Code Tracking API, Cloud Agents REST API,
and TypeScript/Python SDKs. None expose **in-editor** state — there is no documented
extension-host call to ask "what conversation is focused right now?" Cursor's own AI
panels being built into the fork means there's no contributed view id or command an
extension can hook either.

### 3. Hooks as an alternative signal

Cursor's hooks ([cursor.com/docs/hooks](https://cursor.com/docs/hooks)) are the only
mechanism that emits conversation identity to an external process. Confirmed against our
own integration (`cli/configs/cursor/hooks.json`, `cli/internal/cost/cursor.go`):

- Agent hooks (`beforeSubmitPrompt`, `stop`, `afterAgentResponse`, shell/MCP/file
  hooks, `sessionStart`/`sessionEnd`, …) carry a common payload with **`conversation_id`,
  `generation_id`, `model`, `workspace_roots`, `transcript_path`** etc.
- The token-bearing events (`stop`, `afterAgentResponse`) are what our CLI prices into the
  cost feed; both fire per generation with the **same `generation_id`**, so the CLI dedups
  on it.

**But:** hooks fire on agent *activity* (prompt submit, generation stop, tool use). There
is **no `tabFocus` / `tabSwitch` / `activeConversation` hook**, and the app-lifecycle hook
(`workspaceOpen`) deliberately omits `conversation_id`. So hooks tell us *which
conversation just did something*, never *which conversation the user is staring at right
now while idle*.

This is exactly why true focus detection is impossible from the outside: the only signal
that crosses the process boundary is **activity**, not **focus**.

---

## How this maps onto our cost feed

The extension never talks to Cursor directly — it tails the CLI cost feed via
`promptconduit cost watch --json` (`src/watcher.ts`) and consumes `CostEvent` /
`SessionSummary` records (`src/types.ts`). Relevant plumbing:

- The CLI sets the cost feed's **`session_id` = Cursor's `conversation_id`** (falling back
  to `session_id`); see `ParseCursorHookPayload` in `cli/internal/cost/cursor.go`. So
  **one Cursor conversation ≈ one feed `session_id`**, and a "tab" in our model is a
  `session_id`.
- `request_id` = `generation_id` (the dedup key / one billable turn).
- Today `statusBar.ts#updateFromSummary` already approximates "active" by keeping the
  **most-recently-updated session** (`s.updated_at >= activeSession.updated_at`). That is
  the feed-driven approximation in embryonic form — issue #7 just needs to make it
  conversation-aware and add the idle/unseen handling.

---

## Recommendation — confirm the feed-driven approximation

Adopt **"most-recently-active `conversation_id` (feed `session_id`) = the active tab."**
It is the only viable signal, and it matches user intent well in the common single-agent
flow: the conversation you're driving is the one producing events.

### Edge cases & how to treat them

| Case | Behaviour with the approximation | Mitigation |
|---|---|---|
| **Unseen conversation** (tab open, no events yet, or events predate the watcher) | Not in our state → show **$0 + landing page** | Intended. Landing page explains "no priced turns yet for this conversation." |
| **Concurrent agent tabs** (two agents running at once → interleaved events) | "Active" flips to whichever conversation *most recently* produced an event — may not be the visually-focused one | Accept as best-effort; debounce flips (see below) so a single late event from a background agent doesn't yank the bar. Tooltip can name the conversation so the value is never ambiguous. |
| **Idle tab** (user switches to a quiet conversation; no new events) | Bar keeps showing the last *active* (event-producing) conversation, not the focused-but-idle one | Acceptable — the alternative (true focus) is unavailable. Don't auto-reset to $0 on idle; only switch on a *newer* event from another conversation. |
| **Session vs conversation** | Feed `session_id` already == Cursor `conversation_id`, so per-tab granularity is per-conversation, which is what we want | Key all state by `session_id`; do **not** collapse multiple conversations into one workspace total for the bar. |
| **Stale process / restart** | Watcher restart replays from feed tail; "most recent" stays correct | No action — `updated_at` ordering is monotonic per conversation. |

### Honest statement of limitations (for the doc / UI copy)

The bar reflects the **most recently active** AI conversation in this workspace, **not
necessarily the panel currently focused**. In a single-agent workflow these coincide; with
multiple simultaneous agents the bar follows activity. This is a platform constraint
(Cursor exposes no focus signal), not a bug.

---

## Implementation guidance for #7 (2.2)

Replace the single `activeSession` in `statusBar.ts` with per-conversation state and pick
"active" by recency of activity.

**State to keep**

```ts
// keyed by feed session_id (== Cursor conversation_id)
private sessions = new Map<string, SessionSummary>();
private lastEventBySession = new Map<string, CostEvent>();
private activeSessionId: string | undefined;
private activeSetAt = 0; // ms; for debounce on concurrent-tab flips
```

**Picking "active"**

- On each `CostEvent` / `SessionSummary`: upsert into the maps keyed by `session_id`.
- Candidate active = the `session_id` of the record just received (it just produced
  activity). Compare its activity timestamp (`updated_at` for summaries, `ts` for events)
  against the current active session's latest timestamp; switch only if **strictly newer**.
- **Debounce flips between *different* conversations** (e.g. ignore a switch if the new
  conversation's event arrives <~750 ms after we set the current active and the current
  active is still producing events) so two concurrent agents don't make the bar flicker.
  Updates *within* the active conversation are never debounced.
- Render strictly from `sessions.get(activeSessionId)` + `lastEventBySession.get(...)`.

**Unseen / empty state**

- If `activeSessionId` is undefined (no events yet, or none for the open workspace), render
  the **landing page**: `$0.00` in the bar, tooltip/panel = "No priced turns yet for this
  conversation. Cost appears here once an agent turn completes." (Reuse the existing
  `sessionCostLabel()` `$0.00` / `unpriced` logic.)

**Identify the conversation in the UI**

- Show a short conversation id (or workspace + index) in the tooltip so when "active" flips
  between concurrent agents the user can tell which conversation the number belongs to —
  this turns the approximation's main weakness into a transparent, explainable behaviour.

**Do NOT attempt** `window.tabGroups`/`activeTab` correlation, a Cursor extension API, or a
"focus" hook — none of them carry the conversation id (see verdict above). The feed is the
only source of truth.

---

## Sources

- VS Code API — `window.tabGroups`, `Tab`, `TabGroup`, `TabInputWebview` (webview tabs
  expose only `viewType`, no `uri`):
  <https://code.visualstudio.com/api/references/vscode-api>
- VS Code issue #319242 — "Public API to resolve the source resource URI behind a
  webview preview tab" (confirms `TabInputWebview` has no `uri`; no public webview→resource
  mapping): <https://github.com/microsoft/vscode/issues/319242>
- Cursor APIs Overview (server-side only — Admin / Analytics / Cloud Agents; no in-editor
  extension API): <https://cursor.com/docs/api>
- Cursor Hooks reference (payloads carry `conversation_id` / `generation_id` /
  `workspace_roots`; no focus/tab-switch hook): <https://cursor.com/docs/hooks>
- Cursor 2.0 release notes — Composer/Agent are first-class fork UI / top-level Agents
  view, not editor tabs:
  <https://forum.cursor.com/t/cursor-2-0-composer-in-app-browser-voice-more/139132>
- VS Code Webview API guide (webviews are extension-owned surfaces; cross-extension/host
  webview tabs are not introspectable): <https://code.visualstudio.com/api/extension-guides/webview>

Internal cross-references (read-only, for the feed contract):
`cli/configs/cursor/hooks.json`, `cli/internal/cost/cursor.go` (`ParseCursorHookPayload`),
`src/watcher.ts`, `src/statusBar.ts`, `src/types.ts`.
