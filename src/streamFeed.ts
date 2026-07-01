import * as vscode from "vscode";
import { ConversationStore } from "./state";
import { TailReader } from "./visualizer/tailReader";
import { eventsJsonlPath, logDisabled } from "./visualizer/paths";

// Keep memory bounded — we only ever render the tail of one session.
const MAX_EVENTS = 200;
// Match statusBar.ts / eventsFeed.ts: coalesce bursty appends into one render.
const RENDER_THROTTLE_MS = 250;

/** One raw event, scoped to the session that produced it. */
export interface StreamEvent {
  sessionKey: string;
  tool: string;
  hookEvent: string;
  capturedAt: string;
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

// Parse one JSONL envelope line into a StreamEvent. Returns null for blanks,
// malformed JSON, non-object lines, or envelopes with no resolvable session key,
// so a single bad line never breaks the stream. Mirrors eventsFeed.parseLine but
// additionally pulls the session/conversation id out of native_payload.
export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) {
    return null;
  }
  const rec = obj as {
    tool?: unknown;
    hook_event?: unknown;
    captured_at?: unknown;
    native_payload?: { conversation_id?: unknown; session_id?: unknown };
  };
  const np = rec.native_payload ?? {};
  // Same rule the status bar uses: Cursor's per-tab conversation_id when present,
  // else the per-session session_id (Claude Code).
  const sessionKey = ConversationStore.key({
    conversation_id: str(np.conversation_id),
    session_id: str(np.session_id),
  });
  if (!sessionKey) {
    return null;
  }
  return {
    sessionKey,
    tool: str(rec.tool),
    hookEvent: str(rec.hook_event),
    capturedAt: str(rec.captured_at),
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
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
  // Monotonic fallback so records with no usable timestamp still order by arrival.
  private seq = 0;
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

  // Resolve a record's activity time, falling back to arrival order when it has
  // no parseable timestamp so newer records still win.
  private activityFrom(ts: string): number {
    const parsed = parseTs(ts);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
    this.seq += 1;
    return this.seq;
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
 * Server-rendered (enableScripts:false).
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
  // inside the throttle window (mirrors eventsFeed.ts).
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
 * StreamViewProvider hosts the live per-session stream as a docked WebviewView in
 * Cursor's bottom "PromptConduit" panel (view id `promptconduit.stream`). One
 * StreamController per resolved view, torn down when the view is disposed. The
 * pin / follow-active commands drive it via the small forwarding methods below.
 */
export class StreamViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = "promptconduit.stream";
  private controller: StreamController | undefined;

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: false };
    this.controller?.dispose();
    const controller = new StreamController((html) => {
      view.webview.html = html;
    });
    this.controller = controller;
    view.onDidDispose(() => {
      controller.dispose();
      if (this.controller === controller) {
        this.controller = undefined;
      }
    });
    controller.start();
  }

  /** Open a QuickPick of recent sessions and pin the chosen one. */
  async pinSession(): Promise<void> {
    const controller = this.controller;
    if (!controller) {
      void vscode.window.showInformationMessage("Open the PromptConduit Stream panel first.");
      return;
    }
    const sessions = controller.listSessions();
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
      { placeHolder: "Pin the Stream panel to a session (stops auto-following)" },
    );
    if (pick) {
      controller.pin(pick.key);
    }
  }

  /** Resume auto-following the most-recently-active session. */
  followActive(): void {
    if (!this.controller) {
      void vscode.window.showInformationMessage("Open the PromptConduit Stream panel first.");
      return;
    }
    this.controller.unpin();
  }

  dispose(): void {
    this.controller?.dispose();
    this.controller = undefined;
  }
}

// Short, human-friendly session id for the header and picker (keep the tail,
// which is the most distinctive part of a uuid/hash).
export function shortId(key: string): string {
  return key.length > 12 ? `…${key.slice(-8)}` : key;
}

// Build the stream HTML for the followed session. Newest-first, compact for the
// bottom panel, script-free (server-rendered). `buf` is undefined when no session
// is being followed yet (empty / disabled state).
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
  body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 0.4rem 0.6rem; }
  h1 { font-size: 0.95rem; margin: 0 0 0.15rem; }
  .muted { color: var(--vscode-descriptionForeground); }
  .pill { display: inline-block; font-size: 0.72rem; padding: 0.05rem 0.45rem; border-radius: 0.6rem;
          background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-left: 0.35rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; }
  th, td { text-align: left; padding: 0.25rem 0.5rem; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; position: sticky; top: 0; background: var(--vscode-editor-background); }
  td.time, th.time { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .tool, .hook { display: inline-block; font-size: 0.78rem; padding: 0.1rem 0.5rem; border-radius: 0.5rem;
                 background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
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

function buildHeader(
  buf: { key: string; tool: string; events: StreamEvent[] } | undefined,
  pinned: boolean,
): string {
  if (!buf) {
    return `<h1>Live stream</h1>
  <p class="muted">Following the most recently active AI session.</p>`;
  }
  const tool = escape(buf.tool || "session");
  const id = escape(shortId(buf.key));
  const mode = pinned
    ? `<span class="pill">📌 pinned</span>`
    : `<span class="pill">auto-following</span>`;
  return `<h1>${tool} <span class="muted">${id}</span> ${mode}</h1>
  <p class="muted">Live events for this session — newest first. ${
    pinned
      ? "Use <em>Follow Active Session</em> to resume auto-switching."
      : "Switches as you work in another agent tab."
  }</p>`;
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
        <td><span class="hook">${escape(e.hookEvent || "—")}</span></td>
      </tr>`,
    )
    .join("");
}

function tableHtml(rows: string): string {
  return `<table>
    <thead>
      <tr>
        <th class="time">Time</th><th>Tool</th><th>Event</th>
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
