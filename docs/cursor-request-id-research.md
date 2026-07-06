# SPIKE — Cursor agent tab focus via Copy Request ID

> Issue #61 · branch `feat/enrichment-slugs-and-spike` · research only

## TL;DR — Verdict

**NO.** Do not build product code that relies on Copy Request ID for automatic
Cursor agent-tab focus detection.

- **Copy Request ID** is a user-initiated debug affordance in Cursor's agent UI.
  It copies a single-turn identifier (equivalent to hook `generation_id`), not
  the stable tab key (`conversation_id`).
- **VS Code / Cursor extensions have no API** to read the focused agent
  conversation, observe tab switches, or intercept Copy Request ID.
- **events.jsonl correlation is theoretically possible** only after a human
  copies/pastes an ID — it cannot drive automatic focus sync.

**Recommendation:** Keep v1's **activity-based selection** (750ms debounce) plus
**pin / follow** commands. Revisit only if Cursor ships a documented in-editor
focus API or a `tabFocus` hook.

---

## What Copy Request ID contains

Cursor's agent hooks document two stable identifiers on every turn:

| Field | Scope | Role in PromptConduit |
|-------|-------|-------------------------|
| `conversation_id` | One agent/composer chat tab | Feed `session_id` / store key for Cursor |
| `generation_id` | One user prompt → model response cycle | Feed `request_id` (dedup key for pricing) |

From real hook traffic and our CLI integration (`cli/internal/cost/cursor.go`):

- **`conversation_id`** stays constant for the lifetime of an agent tab.
- **`generation_id`** changes on every new prompt within that tab.
- Token-bearing events (`stop`, `afterAgentResponse`) carry **both** fields;
  the CLI dedups on `generation_id`.

**Copy Request ID** (three-dot menu on an agent response) is Cursor's support
debug tool. Community reports and hook parity imply it copies the **current
turn's request / generation id** — i.e. the same value as `generation_id` on
that response — **not** `conversation_id`.

Implications:

- Pasting a copied ID into a lookup table can find **one priced turn**, not
  "which tab is focused right now."
- Multiple tabs can each have recent generations; without a focus signal you
  cannot know which copied ID (if any) represents the visible tab.

---

## Can an extension access it programmatically?

**No.**

1. **No focus API.** Prior spike
   [`cursor-tab-research.md`](cursor-tab-research.md) established that Cursor's
   agent/composer surfaces are fork UI — they do not appear in
   `window.tabGroups`, and webview tabs expose no conversation metadata.

2. **Copy Request ID is clipboard UX, not an extension event.** The VS Code
   extension host exposes clipboard read/write APIs, but:
   - Reading the clipboard requires user gesture / permission and is unsuitable
     for background focus tracking.
   - There is no `onDidCopyRequestId` command or Cursor-contributed API.
   - Polling the clipboard would be fragile, privacy-hostile, and still miss
     tabs the user never copies from.

3. **Cursor's public APIs remain server-side** (Admin, Analytics, Cloud Agents).
   None expose in-editor agent focus state.

4. **Hooks emit activity, not focus.** Hooks fire on prompt submit, tool use,
   and generation stop — never on "user switched to tab B while idle." See the
   Epic 5 addendum in `cursor-tab-research.md`.

---

## Mapping via events.jsonl

**Feasible as a manual debug workflow; not viable for automatic focus.**

Given a UUID from Copy Request ID (treat as `generation_id`):

```text
grep '<uuid>' ~/.promptconduit/events.jsonl
```

A matching v2 envelope line yields:

- `raw_event.generation_id` / cost slug `request_id`
- `raw_event.conversation_id` → the store key for that Cursor tab
- `captured_at`, `tool`, hook event, enrichments

**Limits:**

| Approach | Works? | Why |
|----------|--------|-----|
| Auto-sync focus on tab switch | No | No focus event; clipboard not readable reliably |
| User copies ID → extension looks up tab | Maybe (manual) | Requires explicit paste command; poor UX |
| Infer focus from latest `generation_id` in log | No | Same as activity fallback — follows last event, not focus |

Our extension already tails `events.jsonl` for cost and stream surfaces. Adding
a "paste Request ID to pin session" command would be trivial engineering but
does **not** solve automatic tab focus and duplicates pin/follow with extra
steps.

---

## Comparison to what we ship today (v0.13.0)

| Signal | Automatic? | Matches visible tab? |
|--------|------------|----------------------|
| Activity-based `conversation_id` (750ms debounce) | Yes | Best-effort when one agent is active |
| Pin / follow commands | Manual | Exact when user pins |
| Terminal focus (`sessions resolve --pid`) | Yes (Claude Code) | Matches focused terminal |
| Copy Request ID → events.jsonl lookup | Manual only | Exact for that turn, not ongoing focus |

---

## Recommendation

| Question | Answer |
|----------|--------|
| Build automatic Cursor tab focus on Request ID? | **No** |
| Build optional "paste Request ID to pin" command? | **Defer** — low value vs existing pin picker |
| Keep activity + pin/follow? | **Yes** — only viable automatic signal |

Close #61 as **won't implement (platform gap)** unless Cursor documents an
in-editor focus API or adds a `tabFocus` / `activeConversation` hook.

---

## Sources

- Prior verdict: [`docs/cursor-tab-research.md`](cursor-tab-research.md)
- Cursor hooks reference: <https://cursor.com/docs/hooks>
- Hook deep dive (`conversation_id` vs `generation_id`):
  <https://blog.gitbutler.com/cursor-hooks-deep-dive>
- Copy Request ID forum report (UI clipboard bug, not API):
  <https://forum.cursor.com/t/copy-request-id-not-working-sub-agent/162362>
- Internal: `cli/internal/cost/cursor.go`, `cli/configs/cursor/hooks.json`,
  `src/costFeed.ts`, `src/state.ts`
