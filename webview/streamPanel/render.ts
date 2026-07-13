// Stream webview renderer: StreamPanelState -> HTML strings.
// Pure (no DOM, no vscode) so every section is unit-testable in plain node.
//
// Sibling of the Cost Breakdown renderer: the same toolbar, copy buttons, and
// syntax-lit raw-JSON tape. The body is the live event table, newest first,
// where every row expands into the event's raw envelope JSON. Two shapes:
//   - "all" (default): every session interleaved (Time | Session | Event |
//     Tools | Repo); the Session cell is a clickable badge that drills in.
//   - "session": one drilled session (Time | Tool | Event | Tools | Repo).
// All model/user-controlled strings pass through escapeHtml.

import type { StreamPanelState } from "../../src/streamPanel/protocol";
import type { StreamEvent } from "../../src/streamFeed";
import { escapeHtml, highlightJson } from "../costPanel/jsonHighlight";

// Short, human-friendly session id (keep the distinctive tail). Duplicated from
// streamFeed.shortId so the webview bundle doesn't pull in the vscode-importing
// host module.
function shortId(key: string): string {
  return key.length > 12 ? `…${key.slice(-8)}` : key;
}

// Render the ISO8601 captured_at as a local HH:MM:SS; fall back to the raw
// string if it isn't parseable so we never hide an event.
function fmtTime(iso: string): string {
  if (!iso) {
    return "—";
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleTimeString();
}

function repoLabel(e: StreamEvent): string {
  if (!e.repo) {
    return "—";
  }
  return e.branch ? `${e.repo} @ ${e.branch}` : e.repo;
}

function hookCell(e: StreamEvent): string {
  const hook = escapeHtml(e.hookEvent || "—");
  const badge = e.subagentBadge
    ? ` <span class="subagent-badge">${escapeHtml(e.subagentBadge)}</span>`
    : "";
  return `<span class="hook">${hook}</span>${badge}`;
}

// The unified-feed Session cell: a tool-colored badge that drills into just this
// session's events on click (data-drill carries the full key; main.ts reads it).
function sessionBadge(e: StreamEvent): string {
  const tool = e.tool || "session";
  return `<button type="button" class="sbadge" data-drill="${escapeHtml(e.sessionKey)}" data-tool="${escapeHtml(e.tool)}" title="${escapeHtml(e.sessionKey)}">${escapeHtml(tool)} ${escapeHtml(shortId(e.sessionKey))}</button>`;
}

function toolbarHtml(state: StreamPanelState): string {
  const isSession = state.viewMode === "session";
  const back = isSession
    ? `<button type="button" class="tb" data-cmd="showAll">← All activity</button>`
    : "";
  const drill = isSession
    ? ""
    : `<button type="button" class="tb" data-cmd="drillIn">Drill into session…</button>`;
  const note = isSession
    ? "Drilled into one session."
    : "Showing all activity — every session, newest first.";
  return `<nav class="toolbar">
    ${back}
    <span class="focus-note muted">${escapeHtml(note)}</span>
    <span class="toolbar-spacer"></span>
    <button type="button" class="tb" data-cmd="expandAll">Expand all</button>
    <button type="button" class="tb" data-cmd="collapseAll">Collapse all</button>
    ${drill}
    <button type="button" class="tb" data-cmd="refresh" title="Reload this panel to pick up an extension update — no window reload">↻ Refresh</button>
  </nav>`;
}

function headerHtml(state: StreamPanelState): string {
  if (state.viewMode === "all") {
    const n = state.sessionCount;
    const sess = n === 1 ? "1 live session" : `${n} live sessions`;
    return `<h1>All activity</h1>
  <p class="muted">${escapeHtml(sess)} · interleaved, newest first. Click a session to drill into just its events.</p>`;
  }
  const s = state.session;
  if (!s) {
    return `<h1>Session</h1>`;
  }
  // The explicit, copyable session identity: which id this is depends on the
  // tool — Cursor keys by per-tab conversation_id, Claude Code by session_id.
  const idLabel = s.keyIsConversationId
    ? "conversation_id (Cursor tab)"
    : "session_id (Claude Code)";
  return `<h1>${escapeHtml(s.tool || "session")}</h1>
  <div class="skey-row">
    <span class="skey-label">${escapeHtml(idLabel)}</span>
    <code class="skey">${escapeHtml(s.key)}</code>
    <button type="button" class="copy" data-copy-label="Copy id">Copy id</button>
  </div>
  <p class="muted">Live events for this session — newest first.</p>`;
}

function rowHtml(e: StreamEvent, mode: "all" | "session"): string {
  const body = e.rawJson
    ? `<pre class="tape"><code>${highlightJson(e.rawJson)}</code></pre>
       <button type="button" class="copy" data-copy-label="Copy JSON">Copy JSON</button>`
    : `<p class="muted small">Raw JSON evicted from memory — the full record is in <code>~/.promptconduit/events.jsonl</code>.</p>`;
  const trunc = e.rawTruncated
    ? `<p class="muted small">Truncated at 32&nbsp;KB — full record in <code>~/.promptconduit/events.jsonl</code>.</p>`
    : "";
  const secondCol =
    mode === "all"
      ? `<span class="cell-session">${sessionBadge(e)}</span>`
      : `<span><span class="tool">${escapeHtml(e.tool || "—")}</span></span>`;
  return `<details class="evt" data-exp="${escapeHtml(e.eventId)}">
    <summary class="evt-cols">
      <span class="time">${escapeHtml(fmtTime(e.capturedAt))}</span>
      ${secondCol}
      <span>${hookCell(e)}</span>
      <span class="cell-tools">${escapeHtml(e.toolsSummary || "—")}</span>
      <span class="cell-repo">${escapeHtml(repoLabel(e))}</span>
    </summary>
    <div class="evt-body">${body}${trunc}</div>
  </details>`;
}

function tableHtml(events: StreamEvent[], mode: "all" | "session"): string {
  const secondHead = mode === "all" ? "Session" : "Tool";
  const rows = events
    .slice()
    .reverse()
    .map((e) => rowHtml(e, mode))
    .join("");
  return `<div class="evt-table">
    <div class="evt-cols evt-head">
      <span>Time</span><span>${secondHead}</span><span>Event</span><span>Tools</span><span>Repo</span>
    </div>
    ${rows}
  </div>`;
}

function emptyHtml(state: StreamPanelState): string {
  if (state.logDisabled) {
    return `<div class="empty muted">
    <p>The local event log is <strong>disabled</strong> (<code>PROMPTCONDUIT_EVENT_LOG=0</code>).</p>
    <p>Unset that variable and restart your AI tool to start streaming events.</p>
  </div>`;
  }
  if (state.viewMode === "session") {
    return `<div class="empty muted">
    <p>No events for this session yet. Waiting on <code>~/.promptconduit/events.jsonl</code>…</p>
  </div>`;
  }
  return `<div class="empty muted">
    <p>No activity yet. Run an AI coding session (Claude Code or a Cursor agent) with the
    <code>promptconduit</code> CLI hooks installed and events from every session will stream in
    here within ~1s.</p>
    <p>Waiting on <code>~/.promptconduit/events.jsonl</code>…</p>
  </div>`;
}

/** Full body HTML for one state push. */
export function renderStreamBody(state: StreamPanelState): string {
  const body =
    state.events.length > 0 ? tableHtml(state.events, state.viewMode) : emptyHtml(state);
  return `${toolbarHtml(state)}
  ${headerHtml(state)}
  ${body}
  <footer class="muted">
    Read straight from the local log on your machine. None of your data is sent anywhere.
  </footer>`;
}
