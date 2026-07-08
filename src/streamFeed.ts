import * as vscode from "vscode";
import { ConversationStore } from "./state";
import { parseEnvelopeV2, subagentFrom, toolsFrom } from "./envelope";
import { TailReader } from "./visualizer/tailReader";
import { eventsJsonlPath, logDisabled } from "./visualizer/paths";

// Keep memory bounded — we only ever render the tail of one session.
const MAX_EVENTS = 200;
// Coalesce bursty appends into one render (matches statusBar.ts).
const RENDER_THROTTLE_MS = 250;

const PIN_COMMAND = "promptconduit.stream.pinSession";
const FOLLOW_COMMAND = "promptconduit.stream.followActive";

/** One event, scoped to the session that produced it. */
export interface StreamEvent {
  sessionKey: string;
  tool: string;
  hookEvent: string;
  capturedAt: string;
  /** Repo slug + branch from the envelope's vcs enrichment ("" when absent). */
  repo: string;
  branch: string;
  /** Subagent badge for SubagentStart/Stop rows (e.g. "Explore start"). */
  subagentBadge: string;
  /** Tools summary from the tools slug when present (e.g. "3 tools · 1 failed"). */
  toolsSummary: string;
}

/** A session's live buffer plus the metadata the picker/header need. */
interface SessionBuf {
  key: string;
  tool: string;
  events: StreamEvent[];
  lastActivity: number;
}

/** Session metadata surfaced to the pin QuickPick and the header. */
export interface SessionInfo {
  key: string;
  tool: string;
  count: number;
  lastActivity: number;
}

// Parse one v2 envelope line into a StreamEvent. Returns null for blanks,
// malformed JSON, pre-v2 lines, or envelopes with no resolvable session key,
// so a single bad line never breaks the stream.
export function parseStreamLine(line: string): StreamEvent | null {
  const env = parseEnvelopeV2(line);
  if (!env) {
    return null;
  }
  // Same rule the status bar uses: Cursor's per-tab conversation_id when present,
  // else the envelope's session_id.
  const sessionKey = ConversationStore.key({
    conversation_id: typeof env.raw.conversation_id === "string" ? env.raw.conversation_id : "",
    session_id: env.sessionId,
  });
  if (!sessionKey) {
    return null;
  }
  const sub = subagentFrom(env);
  let subagentBadge = "";
  if (env.hookEvent === "SubagentStart" || env.hookEvent === "SubagentStop") {
    const type = sub?.agent_type || "subagent";
    const phase = sub?.phase || (env.hookEvent === "SubagentStart" ? "start" : "stop");
    subagentBadge = `${type} ${phase}`;
  }
  const tools = toolsFrom(env);
  let toolsSummary = "";
  if (tools?.total && tools.total > 0) {
    const failed = tools.failed ?? 0;
    toolsSummary =
      failed > 0
        ? `${tools.total} tool${tools.total === 1 ? "" : "s"} · ${failed} failed`
        : `${tools.total} tool${tools.total === 1 ? "" : "s"}`;
  }
  return {
    sessionKey,
    tool: env.tool,
    hookEvent: env.hookEvent,
    capturedAt: env.capturedAt,
    repo: env.vcs.repo ?? "",
    branch: env.vcs.branch ?? "",
    subagentBadge,
    toolsSummary,
  };
}

// Parse an ISO timestamp to epoch ms; NaN when absent/unparseable.
function parseTs(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? NaN : ms;
}

/**
 * StreamState is the pure follow/pin logic — no vscode, no fs — so it can be
 * unit-tested and reused (mirrors ConversationStore). It buffers events per
 * session and exposes the FOLLOWED session: the manually pinned one, or (auto-
 * follow) whichever session most recently produced an event.
 */
export class StreamState {
  private readonly bySession = new Map<string, SessionBuf>();
  private activeKey: string | undefined;
  private newestActivity = -Infinity;
  private pinnedKey: string | undefined;

  record(ev: StreamEvent): void {
    const buf = this.ensure(ev.sessionKey);
    if (ev.tool) {
      buf.tool = ev.tool;
    }
    buf.events.push(ev);
    if (buf.events.length > MAX_EVENTS) {
      buf.events.shift();
    }
    this.touch(buf, this.activityFrom(ev.capturedAt));
  }

  /** Pin the followed session; stops auto-switching until unpinned. */
  pin(key: string): void {
    this.pinnedKey = key;
  }

  /** Resume following the most-recently-active session. */
  unpin(): void {
    this.pinnedKey = undefined;
  }

  /** Sessions seen so far, newest activity first (for the pin picker). */
  listSessions(): SessionInfo[] {
    return [...this.bySession.values()]
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .map((b) => ({ key: b.key, tool: b.tool, count: b.events.length, lastActivity: b.lastActivity }));
  }

  /** Key of the session currently rendered (a live pin wins over active). */
  get followedKey(): string | undefined {
    if (this.pinnedKey && this.bySession.has(this.pinnedKey)) {
      return this.pinnedKey;
    }
    return this.activeKey;
  }

  /** True when a pinned session exists and is being followed. */
  get isPinned(): boolean {
    return this.pinnedKey !== undefined && this.bySession.has(this.pinnedKey);
  }

  /** The followed session's buffer, or undefined when nothing is followed yet. */
  followedBuf(): SessionBuf | undefined {
    const key = this.followedKey;
    return key ? this.bySession.get(key) : undefined;
  }

  private ensure(key: string): SessionBuf {
    let buf = this.bySession.get(key);
    if (!buf) {
      buf = { key, tool: "", events: [], lastActivity: -Infinity };
      this.bySession.set(key, buf);
    }
    return buf;
  }

  // Resolve a record's activity time in epoch ms; records with no parseable
  // timestamp count as "now" so they compare in the same units as timestamped
  // ones (a bare counter would never beat an epoch value).
  private activityFrom(ts: string): number {
    const parsed = parseTs(ts);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
    return Math.max(Date.now(), this.newestActivity);
  }

  // Mark a session active if its activity is the newest we've seen (mirrors
  // ConversationStore.touch — ties keep the most-recent caller active).
  private touch(buf: SessionBuf, activity: number): void {
    if (activity >= buf.lastActivity) {
      buf.lastActivity = activity;
    }
    if (buf.lastActivity >= this.newestActivity) {
      this.newestActivity = buf.lastActivity;
      this.activeKey = buf.key;
    }
  }
}

/**
 * StreamController wires the pure StreamState to the live tail of events.jsonl
 * and a throttled HTML render. Host-agnostic: it pushes finished HTML to a sink.
 * Server-rendered (enableScripts:false; pin/follow are command: links).
 */
export class StreamController {
  private readonly tail: TailReader<StreamEvent>;
  private readonly state = new StreamState();
  private disposed = false;
  private pending = false;
  private throttle: NodeJS.Timeout | undefined;

  constructor(private readonly setHtml: (html: string) => void) {
    this.tail = new TailReader<StreamEvent>(eventsJsonlPath(), parseStreamLine, (events) =>
      this.ingest(events),
    );
  }

  start(): void {
    this.render(); // paint the empty / disabled state immediately
    if (!logDisabled()) {
      this.tail.start();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.tail.dispose();
    if (this.throttle) {
      clearTimeout(this.throttle);
      this.throttle = undefined;
    }
  }

  listSessions(): SessionInfo[] {
    return this.state.listSessions();
  }

  pin(key: string): void {
    this.state.pin(key);
    this.render();
  }

  unpin(): void {
    this.state.unpin();
    this.render();
  }

  // Append new events into the state and schedule a render.
  private ingest(events: StreamEvent[]): void {
    for (const ev of events) {
      this.state.record(ev);
    }
    this.scheduleRender();
  }

  // Render now, then coalesce a single trailing render if more events arrive
  // inside the throttle window.
  private scheduleRender(): void {
    if (this.throttle) {
      this.pending = true;
      return;
    }
    this.render();
    this.throttle = setTimeout(() => {
      this.throttle = undefined;
      if (this.pending) {
        this.pending = false;
        this.render();
      }
    }, RENDER_THROTTLE_MS);
  }

  private render(): void {
    if (this.disposed) {
      return;
    }
    this.setHtml(buildStreamHtml(this.state.followedBuf(), this.state.isPinned));
  }
}

/**
 * StreamPanel hosts the live per-session stream as an editor-tab webview (the
 * same surface as the AI Cost Breakdown — the docked bottom-panel container was
 * removed with envelope v2). A single reused panel; show() reveals it. Pin /
 * Follow live as command: links in the rendered header since editor tabs have
 * no view title bar.
 */
export class StreamPanel {
  private static current: StreamPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly controller: StreamController;
  private disposed = false;

  static show(): void {
    if (StreamPanel.current && !StreamPanel.current.disposed) {
      StreamPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    StreamPanel.current = new StreamPanel();
  }

  /** The open panel, if any (the pin/follow commands act on it). */
  static get active(): StreamPanel | undefined {
    return StreamPanel.current && !StreamPanel.current.disposed ? StreamPanel.current : undefined;
  }

  private constructor() {
    this.panel = vscode.window.createWebviewPanel(
      "promptconduitStream",
      "PromptConduit Stream",
      vscode.ViewColumn.Active,
      {
        enableScripts: false,
        retainContextWhenHidden: true,
        enableCommandUris: [PIN_COMMAND, FOLLOW_COMMAND],
      },
    );
    this.controller = new StreamController((html) => {
      this.panel.webview.html = html;
    });
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.controller.dispose();
      if (StreamPanel.current === this) {
        StreamPanel.current = undefined;
      }
    });
    this.controller.start();
  }

  /** Open a QuickPick of recent sessions and pin the chosen one. */
  async pinSession(): Promise<void> {
    const sessions = this.controller.listSessions();
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage("No sessions yet — run an AI coding session first.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: `${s.tool || "session"} · ${shortId(s.key)}`,
        description: `${s.count} event${s.count === 1 ? "" : "s"}`,
        key: s.key,
      })),
      { placeHolder: "Pin the Stream to a session (stops auto-following)" },
    );
    if (pick) {
      this.controller.pin(pick.key);
    }
  }

  /** Resume auto-following the most-recently-active session. */
  followActive(): void {
    this.controller.unpin();
  }
}

// Short, human-friendly session id for the header and picker (keep the tail,
// which is the most distinctive part of a uuid/hash).
export function shortId(key: string): string {
  return key.length > 12 ? `…${key.slice(-8)}` : key;
}

// Build the stream HTML for the followed session. Newest-first, script-free
// (server-rendered; the pin/follow links are command: URIs the host allows).
// `buf` is undefined when no session is being followed yet.
export function buildStreamHtml(
  buf: { key: string; tool: string; events: StreamEvent[] } | undefined,
  pinned: boolean,
): string {
  const header = buildHeader(buf, pinned);
  const body = buf && buf.events.length > 0 ? tableHtml(rowsHtml(buf.events)) : emptyHtml(buf);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 0.6rem 1rem; }
  h1 { font-size: 1.05rem; margin: 0 0 0.15rem; }
  .muted { color: var(--vscode-descriptionForeground); }
  .pill { display: inline-block; font-size: 0.72rem; padding: 0.05rem 0.45rem; border-radius: 0.6rem;
          background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-left: 0.35rem; }
  .actions { margin: 0.2rem 0 0; font-size: 0.85rem; }
  .actions a { color: var(--vscode-textLink-foreground); text-decoration: none; margin-right: 1rem; }
  .actions a:hover { text-decoration: underline; }
  table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; }
  th, td { text-align: left; padding: 0.25rem 0.5rem; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; position: sticky; top: 0; background: var(--vscode-editor-background); }
  td.time, th.time { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .tool, .hook { display: inline-block; font-size: 0.78rem; padding: 0.1rem 0.5rem; border-radius: 0.5rem;
                 background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .subagent-badge { display: inline-block; font-size: 0.72rem; padding: 0.05rem 0.4rem; border-radius: 0.5rem;
                    margin-left: 0.25rem; background: var(--vscode-charts-purple, #a78bfa); color: #fff; }
  td.repo, td.tools { font-size: 0.82rem; color: var(--vscode-descriptionForeground); }
  .empty { margin-top: 1rem; }
  code { background: var(--vscode-textCodeBlock-background); padding: 0.1rem 0.35rem; border-radius: 0.35rem; }
  footer { margin-top: 1rem; font-size: 0.8rem; }
</style>
</head>
<body>
  ${header}
  ${body}
  <footer class="muted">
    Read straight from the local log on your machine. None of your data is sent anywhere.
  </footer>
</body>
</html>`;
}

function actionsHtml(pinned: boolean): string {
  const pin = `<a href="command:${PIN_COMMAND}">📌 Pin a session…</a>`;
  const follow = pinned ? `<a href="command:${FOLLOW_COMMAND}">↻ Follow active session</a>` : "";
  return `<p class="actions">${pin}${follow}</p>`;
}

function buildHeader(
  buf: { key: string; tool: string; events: StreamEvent[] } | undefined,
  pinned: boolean,
): string {
  if (!buf) {
    return `<h1>Live stream</h1>
  <p class="muted">Following the most recently active AI session.</p>
  ${actionsHtml(pinned)}`;
  }
  const tool = escape(buf.tool || "session");
  const id = escape(shortId(buf.key));
  const mode = pinned
    ? `<span class="pill">📌 pinned</span>`
    : `<span class="pill">auto-following</span>`;
  return `<h1>${tool} <span class="muted">${id}</span> ${mode}</h1>
  <p class="muted">Live events for this session — newest first. ${
    pinned
      ? "Use <em>Follow active session</em> to resume auto-switching."
      : "Switches as you work in another agent tab."
  }</p>
  ${actionsHtml(pinned)}`;
}

function repoLabel(e: StreamEvent): string {
  if (!e.repo) {
    return "—";
  }
  return e.branch ? `${e.repo} @ ${e.branch}` : e.repo;
}

function hookCell(e: StreamEvent): string {
  const hook = escape(e.hookEvent || "—");
  const badge = e.subagentBadge
    ? ` <span class="subagent-badge">${escape(e.subagentBadge)}</span>`
    : "";
  return `<span class="hook">${hook}</span>${badge}`;
}

function rowsHtml(events: StreamEvent[]): string {
  return events
    .slice()
    .reverse()
    .map(
      (e) => `
      <tr>
        <td class="time">${escape(fmtTime(e.capturedAt))}</td>
        <td><span class="tool">${escape(e.tool || "—")}</span></td>
        <td>${hookCell(e)}</td>
        <td class="tools">${escape(e.toolsSummary || "—")}</td>
        <td class="repo">${escape(repoLabel(e))}</td>
      </tr>`,
    )
    .join("");
}

function tableHtml(rows: string): string {
  return `<table>
    <thead>
      <tr>
        <th class="time">Time</th><th>Tool</th><th>Event</th><th>Tools</th><th>Repo</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>`;
}

function emptyHtml(buf: { key: string } | undefined): string {
  if (logDisabled()) {
    return `<div class="empty muted">
    <p>The local event log is <strong>disabled</strong> (<code>PROMPTCONDUIT_EVENT_LOG=0</code>).</p>
    <p>Unset that variable and restart your AI tool to start streaming events.</p>
  </div>`;
  }
  if (!buf) {
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

// Render the ISO8601 captured_at as a local HH:MM:SS; fall back to the raw string
// if it isn't parseable so we never hide an event.
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

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
