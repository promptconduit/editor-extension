import * as vscode from "vscode";
import { ConversationStore } from "./state";
import { parseEnvelopeV2, subagentFrom, toolsFrom } from "./envelope";
import { TailReader } from "./visualizer/tailReader";
import { eventsJsonlPath, logDisabled } from "./visualizer/paths";
import { makeNonce, webviewCsp, webviewShellHtml, isSafeHttpUrl } from "./webviewHost";
import { STREAM_PANEL_CSS } from "./streamPanel/styles";
import type { StreamPanelState, WebviewMessage } from "./streamPanel/protocol";

// Keep memory bounded — we only ever render the tail of one session.
export const MAX_EVENTS = 200;
// At most this many concurrent session buffers; beyond it the least-recently-
// active session is evicted entirely.
export const MAX_SESSIONS = 30;
// Per-event raw JSON cap (matches promptGroup's RAW_JSON_MAX).
export const RAW_JSON_MAX = 32 * 1024;
// Per-session raw JSON budget; over it, rawJson is evicted from the session's
// OLDEST events first (metadata is never evicted).
export const SESSION_RAW_BUDGET = 2 * 1024 * 1024;
// Coalesce bursty appends into one render (matches statusBar.ts).
const RENDER_THROTTLE_MS = 250;

/** Commands a webview button may invoke, mapped to real extension commands. */
const COMMAND_MAP: Record<string, string> = {
  pinSession: "promptconduit.stream.pinSession",
  followActive: "promptconduit.stream.followActive",
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
    buf.keyIsConversationId = ev.keyIsConversationId;
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
  followedBuf():
    | { key: string; tool: string; keyIsConversationId: boolean; events: StreamEvent[] }
    | undefined {
    const key = this.followedKey;
    return key ? this.bySession.get(key) : undefined;
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
      if (this.activeKey === victim.key) {
        this.recomputeActive();
      }
    }
  }

  // Re-derive activeKey/newestActivity after an eviction removed the active buf.
  private recomputeActive(): void {
    this.activeKey = undefined;
    this.newestActivity = -Infinity;
    for (const b of this.bySession.values()) {
      if (b.lastActivity >= this.newestActivity) {
        this.newestActivity = b.lastActivity;
        this.activeKey = b.key;
      }
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
 * Build the serializable webview state for the followed session. Pure given
 * its inputs (the preview and tests pass `logDisabled` explicitly; the live
 * controller reads the env flag).
 */
export function buildStreamPanelState(
  state: StreamState,
  revision: number,
  disabled: boolean,
): StreamPanelState {
  const buf = state.followedBuf();
  return {
    revision,
    pinned: state.isPinned,
    logDisabled: disabled,
    session: buf
      ? {
          key: buf.key,
          tool: buf.tool,
          keyIsConversationId: buf.keyIsConversationId,
          count: buf.events.length,
        }
      : undefined,
    events: buf ? [...buf.events] : [],
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
    this.revision += 1;
    this.push(buildStreamPanelState(this.state, this.revision, logDisabled()));
  }
}

/**
 * StreamPanel hosts the live per-session stream as a scripted editor-tab
 * webview (same host pattern as the AI Cost Breakdown: strict CSP + nonce,
 * esbuild bundle from media/, ready/pendingState handshake). A single reused
 * panel; show() reveals it. Pin / Follow are webview toolbar buttons that post
 * `command` messages, routed to the real extension commands.
 */
export class StreamPanel {
  private static current: StreamPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly controller: StreamController;
  private disposed = false;
  private ready = false;
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

    const nonce = makeNonce();
    const scriptUri = this.panel.webview
      .asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "streamPanel.js"))
      .toString();
    this.panel.webview.html = webviewShellHtml({
      csp: webviewCsp(this.panel.webview, nonce),
      nonce,
      scriptUri,
      title: "PromptConduit Stream",
      headHtml: `<style nonce="${nonce}">${STREAM_PANEL_CSS}</style>`,
      bodyHtml: `<div id="app"></div>`,
    });

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
      case "command":
        if (COMMAND_MAP[msg.id]) {
          await vscode.commands.executeCommand(COMMAND_MAP[msg.id]);
        }
        break;
    }
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

// Short, human-friendly session id for the picker and status bar (keep the
// tail, which is the most distinctive part of a uuid/hash).
export function shortId(key: string): string {
  return key.length > 12 ? `…${key.slice(-8)}` : key;
}
