// Stream webview renderer: StreamPanelState -> HTML strings.
// Pure (no DOM, no vscode) so every section is unit-testable in plain node.
//
// Sibling of the Cost Breakdown renderer: the same toolbar, copy buttons, and
// syntax-lit raw-JSON tape — but the body is the live event table (Time |
// Tool | Event | Tools | Repo), newest first, where every row expands into the
// event's raw envelope JSON. All model/user-controlled strings pass through
// escapeHtml.

import type { StreamPanelState } from "../../src/streamPanel/protocol";
import type { StreamEvent } from "../../src/streamFeed";
import { escapeHtml, highlightJson } from "../costPanel/jsonHighlight";

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

function toolbarHtml(state: StreamPanelState): string {
  const note = state.pinned
    ? "Pinned — not auto-following activity."
    : "Following the most recently active AI session.";
  const follow = state.pinned
    ? `<button type="button" class="tb" data-cmd="followActive">Follow active</button>`
    : "";
  return `<nav class="toolbar">
    <span class="focus-note muted">${escapeHtml(note)}</span>
    <span class="toolbar-spacer"></span>
    <button type="button" class="tb" data-cmd="expandAll">Expand all</button>
    <button type="button" class="tb" data-cmd="collapseAll">Collapse all</button>
    <button type="button" class="tb" data-cmd="pinSession">Pin…</button>
    ${follow}
  </nav>`;
}

function headerHtml(state: StreamPanelState): string {
  const s = state.session;
  if (!s) {
    return `<h1>Live stream</h1>
  <p class="muted">Following the most recently active AI session.</p>`;
  }
  const mode = state.pinned
    ? `<span class="pill">📌 pinned</span>`
    : `<span class="pill">auto-following</span>`;
  // The explicit, copyable session identity: which id this is depends on the
  // tool — Cursor keys by per-tab conversation_id, Claude Code by session_id.
  const idLabel = s.keyIsConversationId
    ? "conversation_id (Cursor tab)"
    : "session_id (Claude Code)";
  return `<h1>${escapeHtml(s.tool || "session")} ${mode}</h1>
  <div class="skey-row">
    <span class="skey-label">${escapeHtml(idLabel)}</span>
    <code class="skey">${escapeHtml(s.key)}</code>
    <button type="button" class="copy" data-copy-label="Copy id">Copy id</button>
  </div>
  <p class="muted">Live events for this session — newest first. ${
    state.pinned
      ? "Use <em>Follow active</em> to resume auto-switching."
      : "Switches as you work in another agent tab."
  }</p>`;
}

function rowHtml(e: StreamEvent): string {
  const body = e.rawJson
    ? `<pre class="tape"><code>${highlightJson(e.rawJson)}</code></pre>
       <button type="button" class="copy" data-copy-label="Copy JSON">Copy JSON</button>`
    : `<p class="muted small">Raw JSON evicted from memory — the full record is in <code>~/.promptconduit/events.jsonl</code>.</p>`;
  const trunc = e.rawTruncated
    ? `<p class="muted small">Truncated at 32&nbsp;KB — full record in <code>~/.promptconduit/events.jsonl</code>.</p>`
    : "";
  return `<details class="evt" data-exp="${escapeHtml(e.eventId)}">
    <summary class="evt-cols">
      <span class="time">${escapeHtml(fmtTime(e.capturedAt))}</span>
      <span><span class="tool">${escapeHtml(e.tool || "—")}</span></span>
      <span>${hookCell(e)}</span>
      <span class="cell-tools">${escapeHtml(e.toolsSummary || "—")}</span>
      <span class="cell-repo">${escapeHtml(repoLabel(e))}</span>
    </summary>
    <div class="evt-body">${body}${trunc}</div>
  </details>`;
}

function tableHtml(events: StreamEvent[]): string {
  const rows = events.slice().reverse().map(rowHtml).join("");
  return `<div class="evt-table">
    <div class="evt-cols evt-head">
      <span>Time</span><span>Tool</span><span>Event</span><span>Tools</span><span>Repo</span>
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
  if (!state.session) {
    return `<div class="empty muted">
    <p>No sessions yet. Run an AI coding session (Claude Code or a Cursor agent) with the
    <code>promptconduit</code> CLI hooks installed and its events will stream in here within ~1s.</p>
    <p>Waiting on <code>~/.promptconduit/events.jsonl</code>…</p>
  </div>`;
  }
  return `<div class="empty muted">
    <p>No events for this session yet. Waiting on <code>~/.promptconduit/events.jsonl</code>…</p>
  </div>`;
}

/** Full body HTML for one state push. */
export function renderStreamBody(state: StreamPanelState): string {
  const body =
    state.session && state.events.length > 0 ? tableHtml(state.events) : emptyHtml(state);
  return `${toolbarHtml(state)}
  ${headerHtml(state)}
  ${body}
  <footer class="muted">
    Read straight from the local log on your machine. None of your data is sent anywhere.
  </footer>`;
}
