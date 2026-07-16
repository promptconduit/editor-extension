// Session-tree builder for the live Session Graph panel. Pure logic — no
// vscode, no fs — so it unit-tests in plain node and can be lifted into any
// future surface (platform web app, CLI-served page) unchanged.
//
// Composes the battle-tested PromptGroupStore (turn grouping, tool aggregation,
// subagent start/stop pairing) with per-session metadata, and derives the
// serializable GraphPanelState the webview renders: session root → turns →
// tools + subagents, each with a running/completed/failed/interrupted state.

import { EnvelopeV2, costEventsFrom } from "../envelope";
import { PromptGroup, PromptGroupStore, PromptSubagent } from "../promptGroup";
import type {
  GraphPanelState,
  GraphSessionNode,
  GraphSubagentNode,
  GraphTurnNode,
  NodeState,
  SessionPickerItem,
} from "./protocol";

/** A session with no events for this long (and no SessionEnd) counts as idle, not live. */
export const LIVE_WINDOW_MS = 5 * 60_000;
/** At most this many session metas; beyond it the least-recently-active is evicted. */
const MAX_SESSIONS = 30;
/** Turn boxes rendered per session; older turns collapse into an "N earlier" stub. */
const MAX_TURNS = 50;
/** Prompt text shown on a turn box label. */
const PROMPT_LABEL_MAX = 120;
/** Per-turn tool chips; the rest fold into the total. */
const TOP_TOOLS = 6;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parseTs(ts: string | undefined): number {
  if (!ts) return NaN;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? NaN : ms;
}

// The session key of an envelope — the same rule as ConversationStore.key /
// promptGroup's conversationKeyOf (inlined to keep this module dependency-pure):
// Cursor's per-tab conversation_id when present, else the session id.
function sessionKeyOf(env: EnvelopeV2): string {
  const cid = str(env.raw.conversation_id);
  if (cid) return cid;
  return env.sessionId || str(env.raw.session_id);
}

/** Per-session metadata the picker and the session root node need. */
interface SessionMeta {
  key: string;
  tool: string;
  model?: string;
  repo?: string;
  branch?: string;
  /**
   * The worktree the session ITSELF runs in, latched from its first envelope
   * ("" = not in a worktree). Nodes whose worktree differs get the badge.
   */
  baseWorktreePath: string;
  startedAt?: string;
  /** Epoch ms of the newest event. */
  lastActivity: number;
  ended: boolean;
}

export class SessionTreeStore {
  private readonly store = new PromptGroupStore({ retainRaw: false });
  private readonly meta = new Map<string, SessionMeta>();

  /** Ingest one parsed envelope (idempotent — PromptGroupStore dedups by eventId). */
  ingest(env: EnvelopeV2): void {
    const key = sessionKeyOf(env);
    if (!key) return;
    const m = this.ensure(key, env);
    if (env.tool) m.tool = env.tool;
    const model = str(env.raw.model);
    if (model) m.model = model;
    if (env.vcs.repo) m.repo = env.vcs.repo;
    if (env.vcs.branch) m.branch = env.vcs.branch;
    if (!m.startedAt) m.startedAt = env.capturedAt;
    if (env.hookEvent === "SessionEnd") {
      m.ended = true;
    } else if (env.hookEvent === "SessionStart") {
      m.ended = false; // a resumed session breathes again
    }
    const at = parseTs(env.capturedAt);
    const activity = Number.isNaN(at) ? Math.max(Date.now(), m.lastActivity) : at;
    if (activity > m.lastActivity) m.lastActivity = activity;
    this.store.record(env, costEventsFrom(env));
  }

  /**
   * Build the serializable webview state. `selectedKey` is the user's latched
   * pick (undefined → most recently active live session, else most recent).
   * `now` is injectable for tests.
   */
  snapshot(selectedKey: string | undefined, now: number = Date.now()): Omit<GraphPanelState, "revision" | "logDisabled"> {
    const metas = [...this.meta.values()].sort((a, b) => b.lastActivity - a.lastActivity);
    const sessions: SessionPickerItem[] = metas.map((m) => ({
      key: m.key,
      tool: m.tool,
      repo: m.repo,
      branch: m.branch,
      lastActivity: m.lastActivity,
      live: this.isLive(m, now),
      turnCount: this.store.groupsFor(m.key).length,
    }));

    let selected = selectedKey !== undefined ? metas.find((m) => m.key === selectedKey) : undefined;
    if (!selected) {
      selected = metas.find((m) => this.isLive(m, now)) ?? metas[0];
    }
    return {
      sessions,
      selectedKey: selected?.key,
      session: selected ? this.buildSession(selected, now) : undefined,
    };
  }

  // ---- internals ----

  private ensure(key: string, env: EnvelopeV2): SessionMeta {
    let m = this.meta.get(key);
    if (!m) {
      m = {
        key,
        tool: "",
        // Latched from the session's FIRST envelope: this is where the session
        // itself lives; later events elsewhere are branches worth a badge.
        baseWorktreePath: env.vcs.is_worktree ? (env.vcs.worktree_path ?? "") : "",
        lastActivity: -Infinity,
        ended: false,
      };
      this.meta.set(key, m);
      this.evict(m);
    }
    return m;
  }

  // Bound the metadata map: evict the least-recently-active session (never the
  // one just created). Its PromptGroupStore groups are already bounded per
  // conversation; without a meta entry the session simply leaves the picker.
  private evict(keep: SessionMeta): void {
    while (this.meta.size > MAX_SESSIONS) {
      let victim: SessionMeta | undefined;
      for (const m of this.meta.values()) {
        if (m === keep) continue;
        if (!victim || m.lastActivity < victim.lastActivity) victim = m;
      }
      if (!victim) return;
      this.meta.delete(victim.key);
    }
  }

  private isLive(m: SessionMeta, now: number): boolean {
    return !m.ended && now - m.lastActivity <= LIVE_WINDOW_MS;
  }

  private buildSession(m: SessionMeta, now: number): GraphSessionNode {
    const live = this.isLive(m, now);
    const groups = this.store.groupsFor(m.key);
    const kept = groups.length > MAX_TURNS ? groups.slice(groups.length - MAX_TURNS) : groups;
    const turns = kept.map((g, i) =>
      this.buildTurn(g, m, live, i === kept.length - 1),
    );
    let usd = 0;
    for (const t of turns) usd += t.usdTotal ?? 0;
    return {
      key: m.key,
      tool: m.tool,
      repo: m.repo,
      branch: m.branch,
      model: m.model,
      live,
      ended: m.ended,
      startedAt: m.startedAt,
      lastActivity: m.lastActivity,
      worktreePath: m.baseWorktreePath || undefined,
      turns,
      droppedTurns: this.store.droppedFor(m.key) + (groups.length - kept.length),
      usdTotal: usd > 0 ? usd : undefined,
    };
  }

  private buildTurn(g: PromptGroup, m: SessionMeta, sessionLive: boolean, isLast: boolean): GraphTurnNode {
    const subagents = g.subagents.map((s) => this.buildSubagent(s, g, m, sessionLive));

    // Tool aggregation: counts per name, top-N chips, the rest fold into total.
    const byName = new Map<string, { count: number; failed: number }>();
    let failed = 0;
    for (const c of g.toolCalls) {
      const name = c.name || "tool";
      const agg = byName.get(name) ?? { count: 0, failed: 0 };
      agg.count += 1;
      if (!c.ok) {
        agg.failed += 1;
        failed += 1;
      }
      byName.set(name, agg);
    }
    const top = [...byName.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, TOP_TOOLS)
      .map(([name, agg]) => ({ name, count: agg.count, failed: agg.failed }));

    // State: interrupted and failed are terminal facts; an open turn only
    // "runs" (pulses) while the session is live — stale open turns in a dead
    // session render completed, never pulse forever. A preamble never closes,
    // so it only counts as open while it is the newest group.
    let state: NodeState;
    const open = g.endedAt === undefined && (g.kind !== "preamble" || isLast);
    if (g.interrupted) state = "interrupted";
    else if (g.stopFailed) state = "failed";
    else if (open && sessionLive) state = "running";
    else state = "completed";

    let usd = 0;
    for (const r of g.requests) usd += r.cost.total;
    for (const s of subagents) usd += s.usdTotal ?? 0;

    let durationMs = g.turnDurationMs;
    if (durationMs === undefined && g.startedAt && g.endedAt) {
      const span = parseTs(g.endedAt) - parseTs(g.startedAt);
      if (Number.isFinite(span) && span >= 0) durationMs = span;
    }

    return {
      id: g.id,
      kind: g.kind,
      promptText: g.promptText ? g.promptText.slice(0, PROMPT_LABEL_MAX) : undefined,
      state,
      startedAt: g.startedAt,
      endedAt: g.endedAt,
      durationMs,
      tools: { total: g.toolCalls.length + (g.droppedToolCalls ?? 0), failed, top },
      subagents,
      usdTotal: usd > 0 ? usd : undefined,
      worktreeBadge: this.badge(g.worktreePath, m) || undefined,
      worktreePath: g.worktreePath,
    };
  }

  private buildSubagent(
    s: PromptSubagent,
    g: PromptGroup,
    m: SessionMeta,
    sessionLive: boolean,
  ): GraphSubagentNode {
    // Best-effort failure signal: the Task/Agent tool call that ran this agent
    // type reported ok:false in the same turn. (The subagent slug has no
    // success flag of its own.)
    const taskFailed =
      s.endedAt !== undefined &&
      s.agentType !== "" &&
      g.toolCalls.some((c) => c.agentType === s.agentType && !c.ok);

    let state: NodeState;
    if (s.startedAt !== undefined && s.endedAt === undefined && sessionLive) state = "running";
    else if (taskFailed) state = "failed";
    else state = "completed";

    return {
      agentId: s.agentId,
      agentType: s.agentType || "subagent",
      state,
      durationMs: s.durationMs,
      usdTotal: s.usdTotal,
      model: s.model,
      worktreeBadge: this.badge(s.worktreePath, m) || undefined,
      worktreePath: s.worktreePath,
    };
  }

  // A node earns the worktree badge when it ran in a worktree DIFFERENT from
  // the session's own base (a session started inside a worktree shows that on
  // the root instead).
  private badge(worktreePath: string | undefined, m: SessionMeta): boolean {
    return worktreePath !== undefined && worktreePath !== "" && worktreePath !== m.baseWorktreePath;
  }
}
