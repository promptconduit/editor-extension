import * as vscode from "vscode";
import { ConversationStore } from "./state";
import { parseEnvelopeV2, subagentFrom, toolsFrom } from "./envelope";
import { TailReader } from "./visualizer/tailReader";
import { eventsJsonlPath, logDisabled } from "./visualizer/paths";
import { makeNonce, webviewCsp, webviewShellHtml, isSafeHttpUrl, bustCache } from "./webviewHost";
import { STREAM_PANEL_CSS } from "./streamPanel/styles";
import type { SelectionSource, StreamPanelState, WebviewMessage } from "./streamPanel/protocol";

// Keep memory bounded — we retain the tail of each session's events.
export const MAX_EVENTS = 200;
// At most this many concurrent session buffers; beyond it the least-recently-
// active session is evicted entirely.
export const MAX_SESSIONS = 30;
// Rows rendered in the unified "All activity" view — the interleaved tail across
// every session. Older rows still live per-session (drill in to see them) and in
// events.jsonl.
export const MAX_UNIFIED_ROWS = 400;
// Per-event raw JSON cap (matches promptGroup's RAW_JSON_MAX).
export const RAW_JSON_MAX = 32 * 1024;
// Per-session raw JSON budget; over it, rawJson is evicted from the session's
// OLDEST events first (metadata is never evicted).
export const SESSION_RAW_BUDGET = 2 * 1024 * 1024;
// Coalesce bursty appends into one render (matches statusBar.ts).
const RENDER_THROTTLE_MS = 250;

/** Commands a webview button may invoke, mapped to real extension commands. */
const COMMAND_MAP: Record<string, string> = {
  drillIn: "promptconduit.stream.drillIn",
  showAll: "promptconduit.stream.showAll",
};

/** One event, scoped to the session that produced it. */
export interface StreamEvent {
  sessionKey: string;
  /** Envelope event_id (row identity for expansion state and copy). */
  eventId: string;
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
  /**
   * Pretty-printed envelope JSON (hook_event, prompt_id, captured_at,
   * raw_event, enrichments), truncated at RAW_JSON_MAX. Undefined once evicted
   * by the per-session raw budget.
   */
  rawJson?: string;
  rawTruncated: boolean;
  /** True when the session key came from raw.conversation_id (a Cursor tab). */
  keyIsConversationId: boolean;
  /**
   * Activity time in epoch ms, stamped by StreamState.record (not by the parser)
   * — the sort key for the unified feed. Undefined until recorded.
   */
  at?: number;
  /**
   * Monotonic ingest order, stamped by StreamState.record. Ties the unified sort
   * when two sessions share a captured_at (common when both tools write in the
   * same millisecond). Undefined until recorded.
   */
  seq?: number;
}

/** A session's live buffer plus the metadata the picker/header need. */
interface SessionBuf {
  key: string;
  tool: string;
  keyIsConversationId: boolean;
  events: StreamEvent[];
  /** Sum of retained rawJson lengths, enforced against SESSION_RAW_BUDGET. */
  rawBytes: number;
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
  const conversationId =
    typeof env.raw.conversation_id === "string" ? env.raw.conversation_id : "";
  const sessionKey = ConversationStore.key({
    conversation_id: conversationId,
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
  // Pretty-printed raw record (same shape and 32 KiB cap as promptGroup's
  // attachRaw, so the two panels show the exact same inspector payload).
  let rawJson: string | undefined;
  let rawTruncated = false;
  try {
    rawJson = JSON.stringify(
      {
        hook_event: env.hookEvent,
        prompt_id: env.promptId || undefined,
        captured_at: env.capturedAt,
        raw_event: env.raw,
        enrichments: env.enrichments,
      },
      null,
      2,
    );
  } catch {
    rawJson = undefined; // non-serializable — keep the metadata anyway
  }
  if (rawJson !== undefined && rawJson.length > RAW_JSON_MAX) {
    rawJson = rawJson.slice(0, RAW_JSON_MAX);
    rawTruncated = true;
  }
  return {
    sessionKey,
    eventId: env.eventId || `${env.hookEvent}@${env.capturedAt}`,
    tool: env.tool,
    hookEvent: env.hookEvent,
    capturedAt: env.capturedAt,
    repo: env.vcs.repo ?? "",
    branch: env.vcs.branch ?? "",
    subagentBadge,
    toolsSummary,
    rawJson,
    rawTruncated,
    keyIsConversationId: conversationId.length > 0,
  };
}

// Parse an ISO timestamp to epoch ms; NaN when absent/unparseable.
function parseTs(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? NaN : ms;
}

/**
 * StreamState is the pure view logic — no vscode, no fs — so it can be
 * unit-tested and reused (mirrors ConversationStore). It buffers events per
 * session and exposes two views: the DEFAULT unified feed (`allEntries` —
 * every session interleaved, newest first) and, when the user drills into one,
 * that single session's buffer. There is no auto-follow: the feed never moves
 * on its own, so a chatty Claude Code session can't steal the view from a
 * quiet Cursor agent.
 */
export class StreamState {
  private readonly bySession = new Map<string, SessionBuf>();
  private newestActivity = -Infinity;
  // The session the user drilled into; undefined (or evicted) → unified view.
  private drilledKey: string | undefined;
  // How the drilled session was chosen: a toolbar/badge click, or a selection
  // gesture (focused terminal / selected Cursor agent tab). Event recency is
  // NEVER a reason — the feed still doesn't move on its own.
  private drillSource: "manual" | SelectionSource | undefined;
  // A selection gesture for a session that hasn't streamed yet: drill the
  // moment its first event lands instead of showing an empty view.
  private pendingSelectKey: string | undefined;
  private pendingSelectSource: SelectionSource = "terminal";
  // Monotonic ingest counter, stamped onto each event as its unified-sort tie-break.
  private seqCounter = 0;

  record(ev: StreamEvent): void {
    const buf = this.ensure(ev.sessionKey);
    // A selected-but-not-yet-streamed session materialized — honor the gesture.
    if (this.pendingSelectKey === ev.sessionKey) {
      this.drilledKey = ev.sessionKey;
      this.drillSource = this.pendingSelectSource;
      this.pendingSelectKey = undefined;
    }
    if (ev.tool) {
      buf.tool = ev.tool;
    }
    buf.keyIsConversationId = ev.keyIsConversationId;
    // Stamp the sort keys once, here — the parser can't (it has no ingest order
    // and shouldn't reach for the clock).
    const at = this.activityFrom(ev.capturedAt);
    ev.at = at;
    ev.seq = ++this.seqCounter;
    buf.events.push(ev);
    buf.rawBytes += ev.rawJson?.length ?? 0;
    if (buf.events.length > MAX_EVENTS) {
      const dropped = buf.events.shift();
      if (dropped?.rawJson !== undefined) {
        buf.rawBytes -= dropped.rawJson.length;
      }
    }
    // Enforce the per-session raw budget: strip rawJson from the OLDEST events
    // first, keeping the row metadata so the table never loses history.
    if (buf.rawBytes > SESSION_RAW_BUDGET) {
      for (const e of buf.events) {
        if (buf.rawBytes <= SESSION_RAW_BUDGET) {
          break;
        }
        if (e.rawJson !== undefined) {
          buf.rawBytes -= e.rawJson.length;
          e.rawJson = undefined;
        }
      }
    }
    this.touch(buf, at);
  }

  /** Drill into one session; the panel then shows only its events. */
  drillIn(key: string): void {
    this.drilledKey = key;
    this.drillSource = "manual";
    this.pendingSelectKey = undefined;
  }

  /**
   * A selection gesture: the user focused a terminal or selected a Cursor
   * agent tab. Drills into that session (immediately if it has streamed,
   * else as soon as its first event lands). Unlike drillIn this is
   * best-effort UI following, so callers gate it on the followSelection
   * setting.
   */
  selectSession(key: string, source: SelectionSource): void {
    if (this.bySession.has(key)) {
      this.drilledKey = key;
      this.drillSource = source;
      this.pendingSelectKey = undefined;
      return;
    }
    this.pendingSelectKey = key;
    this.pendingSelectSource = source;
  }

  /** Return to the unified "All activity" feed (also cancels a pending selection). */
  showAll(): void {
    this.drilledKey = undefined;
    this.drillSource = undefined;
    this.pendingSelectKey = undefined;
  }

  /** Why the current drilled view was chosen by a gesture, if it was. */
  get selectedVia(): SelectionSource | undefined {
    if (this.viewMode !== "session") {
      return undefined;
    }
    return this.drillSource === "terminal" || this.drillSource === "cursor-tab"
      ? this.drillSource
      : undefined;
  }

  /**
   * "session" when the user has drilled into a session that still exists,
   * else "all". An evicted drilled session falls back to the unified feed.
   */
  get viewMode(): "all" | "session" {
    return this.drilledKey !== undefined && this.bySession.has(this.drilledKey) ? "session" : "all";
  }

  /** Live session buffers (for the header count and picker). */
  get sessionCount(): number {
    return this.bySession.size;
  }

  /** Sessions seen so far, newest activity first (for the drill picker). */
  listSessions(): SessionInfo[] {
    return [...this.bySession.values()]
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .map((b) => ({ key: b.key, tool: b.tool, count: b.events.length, lastActivity: b.lastActivity }));
  }

  /**
   * The unified feed: every session's retained events interleaved by activity
   * time (then ingest order), newest LAST — matching the per-session buffer
   * convention the webview renders (it reverses to show newest first). Capped
   * at `limit` rows; older rows remain per-session (drill in) and in events.jsonl.
   */
  allEntries(limit = MAX_UNIFIED_ROWS): StreamEvent[] {
    const all: StreamEvent[] = [];
    for (const buf of this.bySession.values()) {
      for (const e of buf.events) {
        all.push(e);
      }
    }
    all.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));
    return all.length > limit ? all.slice(all.length - limit) : all;
  }

  /** The drilled session's buffer, or undefined in the unified view. */
  drilledBuf(): SessionBuf | undefined {
    return this.viewMode === "session" ? this.bySession.get(this.drilledKey!) : undefined;
  }

  private ensure(key: string): SessionBuf {
    let buf = this.bySession.get(key);
    if (!buf) {
      buf = { key, tool: "", keyIsConversationId: false, events: [], rawBytes: 0, lastActivity: -Infinity };
      this.bySession.set(key, buf);
      this.evictSessions(buf);
    }
    return buf;
  }

  // Bound the number of session buffers: evict the least-recently-active
  // session entirely (never the one just created for the incoming event).
  private evictSessions(keep: SessionBuf): void {
    while (this.bySession.size > MAX_SESSIONS) {
      let victim: SessionBuf | undefined;
      for (const b of this.bySession.values()) {
        if (b === keep) {
          continue;
        }
        if (!victim || b.lastActivity < victim.lastActivity) {
          victim = b;
        }
      }
      if (!victim) {
        return;
      }
      this.bySession.delete(victim.key);
      // A drilled session that gets evicted simply drops back to the unified
      // view (viewMode guards on bySession.has) — no extra bookkeeping needed.
    }
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

  // Track the newest activity as a floor for untimestamped events, and keep the
  // session's own last-activity for the picker sort and LRU eviction.
  private touch(buf: SessionBuf, activity: number): void {
    if (activity >= buf.lastActivity) {
      buf.lastActivity = activity;
    }
    if (buf.lastActivity >= this.newestActivity) {
      this.newestActivity = buf.lastActivity;
    }
  }
}

/**
 * Build the serializable webview state. Pure given its inputs (the preview and
 * tests pass `logDisabled` explicitly; the live controller reads the env flag).
 * Unified view (default) carries the interleaved feed with no `session`; a
 * drilled view carries that one session and its buffer.
 */
export function buildStreamPanelState(
  state: StreamState,
  revision: number,
  disabled: boolean,
): StreamPanelState {
  const buf = state.drilledBuf();
  if (buf) {
    return {
      revision,
      viewMode: "session",
      logDisabled: disabled,
      sessionCount: state.sessionCount,
      session: {
        key: buf.key,
        tool: buf.tool,
        keyIsConversationId: buf.keyIsConversationId,
        count: buf.events.length,
      },
      selected: state.selectedVia,
      events: [...buf.events],
    };
  }
  return {
    revision,
    viewMode: "all",
    logDisabled: disabled,
    sessionCount: state.sessionCount,
    session: undefined,
    events: state.allEntries(),
  };
}

/**
 * StreamController wires the pure StreamState to the live tail of events.jsonl
 * and a throttled state push. Host-agnostic: it pushes StreamPanelState to a
 * sink callback (the panel posts it to the webview; the preview writes it into
 * a shim page).
 */
export class StreamController {
  private readonly tail: TailReader<StreamEvent>;
  private readonly state = new StreamState();
  private disposed = false;
  private pending = false;
  private throttle: NodeJS.Timeout | undefined;
  private revision = 0;

  constructor(private readonly push: (state: StreamPanelState) => void) {
    this.tail = new TailReader<StreamEvent>(eventsJsonlPath(), parseStreamLine, (events) =>
      this.ingest(events),
    );
  }

  start(): void {
    this.render(); // push the empty / disabled state immediately
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

  drillIn(key: string): void {
    this.state.drillIn(key);
    this.render();
  }

  /** Follow a selection gesture (focused terminal / selected Cursor tab). */
  selectSession(key: string, source: SelectionSource): void {
    this.state.selectSession(key, source);
    this.render();
  }

  showAll(): void {
    this.state.showAll();
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
    this.revision += 1;
    this.push(buildStreamPanelState(this.state, this.revision, logDisabled()));
  }
}

/**
 * StreamPanel hosts the live per-session stream as a scripted editor-tab
 * webview (same host pattern as the AI Cost Breakdown: strict CSP + nonce,
 * esbuild bundle from media/, ready/pendingState handshake). A single reused
 * panel; show() reveals it. Drill in / All activity are webview toolbar buttons
 * (and clickable session badges) that post messages, routed to the real
 * extension commands.
 */
export class StreamPanel {
  private static current: StreamPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly controller: StreamController;
  private disposed = false;
  private ready = false;
  // Bumped on every shell (re)render so a refresh cache-busts the bundle URI.
  private htmlRev = 0;
  private lastState: StreamPanelState | undefined;

  static show(extensionUri: vscode.Uri): void {
    if (StreamPanel.current && !StreamPanel.current.disposed) {
      StreamPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    StreamPanel.current = new StreamPanel(extensionUri);
  }

  /** The open panel, if any (the pin/follow commands act on it). */
  static get active(): StreamPanel | undefined {
    return StreamPanel.current && !StreamPanel.current.disposed ? StreamPanel.current : undefined;
  }

  private constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
    this.panel = vscode.window.createWebviewPanel(
      "promptconduitStream",
      "PromptConduit Stream",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );

    this.renderShell();

    this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      void this.onMessage(msg);
    });
    this.controller = new StreamController((state) => this.push(state));
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.controller.dispose();
      if (StreamPanel.current === this) {
        StreamPanel.current = undefined;
      }
    });
    this.controller.start();
  }

  // (Re)build the webview document with a fresh nonce and cache-busted bundle
  // URI, so calling it again reloads the webview in place and picks up a rebuilt
  // media/streamPanel.js — no window reload.
  private renderShell(): void {
    this.htmlRev += 1;
    const nonce = makeNonce();
    const scriptUri = bustCache(
      this.panel.webview
        .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "streamPanel.js"))
        .toString(),
      this.htmlRev,
    );
    this.panel.webview.html = webviewShellHtml({
      csp: webviewCsp(this.panel.webview, nonce),
      nonce,
      scriptUri,
      title: "PromptConduit Stream",
      headHtml: `<style nonce="${nonce}">${STREAM_PANEL_CSS}</style>`,
      bodyHtml: `<div id="app"></div>`,
    });
  }

  // Reload the webview in place; live events keep flowing through the controller
  // and lastState is re-pushed on the next "ready".
  private refresh(): void {
    this.ready = false;
    this.renderShell();
  }

  /**
   * Reload the panel's webview if it is the active editor. Returns whether it
   * acted, so the Refresh Panel command can fall through to another panel.
   */
  static refreshActive(): boolean {
    const p = StreamPanel.current;
    if (p && !p.disposed && p.panel.active) {
      p.refresh();
      return true;
    }
    return false;
  }

  private push(state: StreamPanelState): void {
    this.lastState = state;
    if (!this.ready) {
      return; // delivered on "ready"
    }
    void this.panel.webview.postMessage({ type: "state", state });
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.ready = true;
        if (this.lastState) {
          void this.panel.webview.postMessage({ type: "state", state: this.lastState });
        }
        break;
      case "open_external":
        if (isSafeHttpUrl(msg.url)) {
          await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        break;
      case "drill":
        // Session badge clicked in the unified feed — drill straight in, no picker.
        this.controller.drillIn(msg.key);
        break;
      case "command":
        if (msg.id === "refresh") {
          this.refresh();
        } else if (COMMAND_MAP[msg.id]) {
          await vscode.commands.executeCommand(COMMAND_MAP[msg.id]);
        }
        break;
    }
  }

  /** Open a QuickPick of recent sessions and drill into the chosen one. */
  async drillIntoSession(): Promise<void> {
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
      { placeHolder: "Drill into one session's events" },
    );
    if (pick) {
      this.controller.drillIn(pick.key);
    }
  }

  /** Return to the unified "All activity" feed. */
  showAll(): void {
    this.controller.showAll();
  }

  /**
   * Follow a selection gesture from the host (focused terminal or selected
   * Cursor agent tab): drill this panel into that session. The caller gates
   * on the promptconduit.stream.followSelection setting.
   */
  selectSession(key: string, source: SelectionSource): void {
    this.controller.selectSession(key, source);
  }
}

// Short, human-friendly session id for the picker and status bar (keep the
// tail, which is the most distinctive part of a uuid/hash).
export function shortId(key: string): string {
  return key.length > 12 ? `…${key.slice(-8)}` : key;
}
