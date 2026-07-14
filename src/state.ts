// Per-conversation cost state. Pure logic — no vscode import — so it can be
// unit-tested and reused. Conversations are keyed by Cursor's per-tab
// `conversation_id`, falling back to `session_id` (Claude Code).
//
// Since envelope v2 the store also ACCUMULATES the session summary locally
// (totals, per-model breakdown, tool counts, recomputed signals) from the
// per-request cost events — the CLI no longer streams a session_summary
// record. The status bar and default breakdown read displayKey (terminal
// focus, pin, or debounced activity); the all-sessions view uses list().

import { CostEvent, ModelTotal, SessionSummary, Signals, Tokens } from "./types";
import {
  DiffEnrichment,
  EnvelopeV2,
  VCSEnrichment,
  costEventsFrom,
  subagentFrom,
  diffFrom,
} from "./envelope";
import { PromptGroup, PromptGroupStore } from "./promptGroup";

/** Aggregated subagent stats for a session (from SubagentStop enrichments). */
export interface SessionSubagentSummary {
  count: number;
  totalDurationMs: number;
  totalUsd: number;
  /** Most-used agent type across completed subagents. */
  dominantType: string;
}

/** Everything the panel needs to render one conversation. */
export interface ConversationView {
  key: string;
  tool: string;
  summary: SessionSummary;
  lastEvent?: CostEvent;
  /** Recent turns, oldest first. */
  recent: CostEvent[];
  /** Turns evicted from `recent` by the memory cap (still counted in totals). */
  droppedRequests: number;
  lastActivity: number;
  /** Latest diff stats from a turn-end event (Stop / SessionEnd). */
  diff?: DiffEnrichment;
  /** Rolled-up subagent usage for the session. */
  subagents?: SessionSubagentSummary;
  /** Latest VCS context seen on this conversation's envelopes. */
  vcs?: VCSEnrichment;
  /** Per-prompt groups (requests, tools, subagents, raw events), append order. */
  prompts?: PromptGroup[];
  /** Prompt groups evicted by the per-conversation cap. */
  droppedPrompts?: number;
}

export type FocusSource = "prompted" | "terminal" | "cursor-tab" | "activity" | "pinned";

/** Gesture kinds that can set the latch (everything but the fallbacks). */
export type LatchSource = "prompted" | "terminal" | "cursor-tab";

// Per-conversation accumulated cost state.
interface ConversationState {
  key: string;
  tool: string;
  lastEvent?: CostEvent;
  recent: CostEvent[];
  droppedRecent: number;
  counted: Set<string>;
  // Envelope-level dedup for enrichment accumulation (diff/subagent), so a tail
  // reset on file rotation can't double-apply. FIFO-bounded companion queue.
  seenEnrichments: Set<string>;
  seenEnrichmentsOrder: string[];
  totals: Tokens & { cost_total: number };
  costParts: { input: number; cache_write: number };
  byModel: Map<string, ModelTotal>;
  toolsTotal: number;
  toolsByName: Map<string, number>;
  source: string;
  startedAt: string;
  updatedAt: string;
  lastActivity: number;
  diff?: DiffEnrichment;
  vcs?: VCSEnrichment;
  subagentCount: number;
  subagentDurationMs: number;
  subagentUsd: number;
  subagentByType: Map<string, number>;
}

// Debounce rapid activity flips when concurrent Cursor agents run.
export const ACTIVE_KEY_DEBOUNCE_MS = 750;

// A signal (prompt submit or terminal focus) holds the displayed session this
// long — even through another session's event burst — before falling back to
// plain activity. Just a safety net; a newer signal always wins immediately.
export const LATCH_TTL_MS = 10 * 60 * 1000;

// Cap on retained per-request events per conversation. Aggregate totals stay
// exact; only the drill-down list is bounded (older turns live in events.jsonl).
export const MAX_RECENT_REQUESTS = 1000;

// Bound on the enrichment dedup set per conversation.
const MAX_SEEN_ENRICHMENTS = 4000;

// Parse an ISO timestamp to epoch ms; NaN when absent/unparseable.
function parseTs(ts: string | undefined): number {
  if (!ts) {
    return NaN;
  }
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? NaN : ms;
}

function cacheHitRate(input: number, cacheRead: number, cacheWrite: number): number {
  const denom = cacheRead + cacheWrite + input;
  return denom > 0 ? cacheRead / denom : 0;
}

function inputTokenShare(input: number, cacheRead: number, cacheWrite: number): number {
  const denom = input + cacheRead + cacheWrite;
  return denom > 0 ? input / denom : 0;
}

function modelTier(model: string, priced: boolean): string {
  if (!priced || !model) {
    return "unknown";
  }
  const m = model.toLowerCase();
  if (/(haiku|mini|nano|flash)/.test(m)) {
    return "economy";
  }
  if (/(opus|gpt-5|gpt-4|ultra|-pro)/.test(m)) {
    return "premium";
  }
  return "standard";
}

/**
 * ConversationStore keeps cost state keyed by conversation (Cursor per-tab) or,
 * absent that, by session (Claude Code). displayKey = pinned ?? latched ??
 * active. The "latch" is the most recent signal — a prompt submission in either
 * tool, or a terminal focus change — so the status bar follows what you last
 * acted in ("last prompted wins") instead of whichever session emits the most
 * events. VS Code exposes no Cursor tab-focus event, so a prompt is the best
 * signal we get from a Cursor agent.
 */
export class ConversationStore {
  private readonly byKey = new Map<string, ConversationState>();
  private readonly promptGroups = new PromptGroupStore();
  private activeKeyRef: string | undefined;
  private newestActivity = -Infinity;
  // The most recent signal: what the user last prompted in or focused.
  private latchedKey: string | undefined;
  private latchedAt = 0;
  private latchSource: LatchSource = "prompted";
  private pinnedKeyRef: string | undefined;
  private pendingActiveKey: string | undefined;
  private activeDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private onActiveDebounced: (() => void) | undefined;

  /** Called when debounced activeKey flips (for UI refresh). */
  setOnActiveDebounced(fn: () => void): void {
    this.onActiveDebounced = fn;
  }

  /** The key (conversation_id or session_id) of a record. */
  static key(rec: { conversation_id?: string; session_id: string }): string {
    return rec.conversation_id && rec.conversation_id.length > 0
      ? rec.conversation_id
      : rec.session_id;
  }

  private ensure(key: string): ConversationState {
    let state = this.byKey.get(key);
    if (!state) {
      state = {
        key,
        tool: "",
        recent: [],
        droppedRecent: 0,
        counted: new Set(),
        seenEnrichments: new Set(),
        seenEnrichmentsOrder: [],
        totals: { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_total: 0 },
        costParts: { input: 0, cache_write: 0 },
        byModel: new Map(),
        toolsTotal: 0,
        toolsByName: new Map(),
        source: "",
        startedAt: "",
        updatedAt: "",
        lastActivity: -Infinity,
        subagentCount: 0,
        subagentDurationMs: 0,
        subagentUsd: 0,
        subagentByType: new Map(),
      };
      this.byKey.set(key, state);
    }
    return state;
  }

  // Resolve a record's activity time in epoch ms. Records with no parseable
  // timestamp count as "now" (arrival time) so they compare in the same units
  // as timestamped records — a tiny counter here would lose to any epoch value
  // and the session could never become active or sort correctly.
  private activityFrom(ts: string | undefined): number {
    const parsed = parseTs(ts);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
    return Math.max(Date.now(), this.newestActivity);
  }

  private touch(state: ConversationState, activity: number): void {
    if (activity >= state.lastActivity) {
      state.lastActivity = activity;
    }
    if (state.lastActivity < this.newestActivity) {
      return;
    }
    this.newestActivity = state.lastActivity;
    const nextKey = state.key;
    if (nextKey === this.activeKeyRef) {
      this.clearActiveDebounce();
      return;
    }
    if (this.activeKeyRef === undefined) {
      this.activeKeyRef = nextKey;
      return;
    }
    this.pendingActiveKey = nextKey;
    if (this.activeDebounceTimer) {
      return;
    }
    this.activeDebounceTimer = setTimeout(() => {
      this.activeDebounceTimer = undefined;
      if (this.pendingActiveKey) {
        this.activeKeyRef = this.pendingActiveKey;
        this.pendingActiveKey = undefined;
        this.onActiveDebounced?.();
      }
    }, ACTIVE_KEY_DEBOUNCE_MS);
  }

  private clearActiveDebounce(): void {
    this.pendingActiveKey = undefined;
    if (this.activeDebounceTimer) {
      clearTimeout(this.activeDebounceTimer);
      this.activeDebounceTimer = undefined;
    }
  }

  // Record the most recent signal. Prompt submissions and terminal focus both
  // set it; whichever happened last wins. Uses wall-clock so the TTL is real
  // time, not event time (a focused terminal whose session is quiet still holds).
  private setLatch(key: string, source: LatchSource): void {
    this.latchedKey = key;
    this.latchedAt = Date.now();
    this.latchSource = source;
  }

  // Terminal focus is one kind of signal. A bare `undefined` (focus left the
  // terminal, e.g. to a Cursor pane) does NOT clear the latch — clearing it
  // would just snap the display to whatever session is chattiest.
  setFocusedKey(key: string | undefined): void {
    if (key) {
      this.setLatch(key, "terminal");
    }
  }

  // Selecting a Cursor agent tab is another signal (read from Cursor's own
  // workspace-storage record of the focused tab; the composerId IS this
  // store's conversation key). Same rule as terminals: `undefined` (no tab
  // focused / record unreadable) never clears the latch.
  setCursorTabKey(key: string | undefined): void {
    if (key) {
      this.setLatch(key, "cursor-tab");
    }
  }

  setPinnedKey(key: string | undefined): void {
    this.pinnedKeyRef = key;
  }

  clearPin(): void {
    this.pinnedKeyRef = undefined;
  }

  get pinnedKey(): string | undefined {
    return this.pinnedKeyRef;
  }

  // The latch wins only once its session has events (a terminal focused before
  // its session produced anything falls through) and while it's fresh (a signal
  // older than the TTL yields to plain activity).
  private get liveLatchedKey(): string | undefined {
    if (!this.latchedKey || !this.byKey.has(this.latchedKey)) {
      return undefined;
    }
    if (Date.now() - this.latchedAt > LATCH_TTL_MS) {
      return undefined;
    }
    return this.latchedKey;
  }

  /** Key shown in the status bar and default breakdown. */
  get displayKey(): string | undefined {
    if (this.pinnedKeyRef && this.byKey.has(this.pinnedKeyRef)) {
      return this.pinnedKeyRef;
    }
    const latched = this.liveLatchedKey;
    if (latched) {
      return latched;
    }
    return this.activeKeyRef;
  }

  get focusSource(): FocusSource {
    if (this.pinnedKeyRef && this.byKey.has(this.pinnedKeyRef)) {
      return "pinned";
    }
    if (this.liveLatchedKey) {
      return this.latchSource;
    }
    return "activity";
  }

  /** Cancel the pending active-key debounce (call on extension teardown). */
  dispose(): void {
    this.clearActiveDebounce();
  }

  recordEvent(ev: CostEvent): void {
    const key = ConversationStore.key(ev);
    const state = this.ensure(key);
    if (ev.tool) {
      state.tool = ev.tool;
    }
    state.lastEvent = ev;
    this.recordRecent(state, ev);
    this.accumulate(state, ev);
    this.touch(state, this.activityFrom(ev.ts));
  }

  /** Apply non-cost enrichment slugs (diff, subagent) from a v2 envelope. */
  recordEnvelope(env: EnvelopeV2): void {
    const rawSession =
      typeof env.raw.session_id === "string" ? env.raw.session_id : "";
    const key = ConversationStore.key({
      conversation_id: typeof env.raw.conversation_id === "string" ? env.raw.conversation_id : "",
      session_id: env.sessionId || rawSession,
    });
    if (!key) {
      return;
    }
    const state = this.ensure(key);
    if (env.tool) {
      state.tool = env.tool;
    }

    // A user submitting a prompt is the strongest "I'm working here now" signal
    // (Cursor beforeSubmitPrompt / Claude Code UserPromptSubmit) — latch the
    // display to it so a chatty concurrent session can't pull the status bar
    // away. This is how a Cursor agent claims the display without a tab-focus API.
    if (env.hookEvent === "beforeSubmitPrompt" || env.hookEvent === "UserPromptSubmit") {
      this.setLatch(key, "prompted");
    }

    // Per-prompt correlation runs on every envelope; the group store dedups
    // by eventId (when the CLI provides one) so it sits before the
    // enrichment-accumulation guard.
    this.promptGroups.record(env, costEventsFrom(env));

    if (env.vcs && (env.vcs.repo || env.vcs.branch)) {
      state.vcs = env.vcs; // latest context wins
    }

    const sub = subagentFrom(env);
    // Dedup so a tail reset (file rotation re-read) can't double-apply
    // diff/subagent accumulation — mirrors `counted` for cost requests.
    const dedupKey =
      env.eventId ||
      (sub ? `sub:${sub.agent_id ?? ""}:${sub.phase ?? ""}` : `${env.hookEvent}:${env.capturedAt}`);
    if (state.seenEnrichments.has(dedupKey)) {
      this.touch(state, this.activityFrom(env.capturedAt));
      return;
    }
    state.seenEnrichments.add(dedupKey);
    state.seenEnrichmentsOrder.push(dedupKey);
    if (state.seenEnrichmentsOrder.length > MAX_SEEN_ENRICHMENTS) {
      const oldest = state.seenEnrichmentsOrder.shift();
      if (oldest) {
        state.seenEnrichments.delete(oldest);
      }
    }

    const diff = diffFrom(env);
    if (diff && (env.hookEvent === "Stop" || env.hookEvent === "SessionEnd")) {
      state.diff = diff;
    }

    if (sub?.phase === "stop") {
      state.subagentCount += 1;
      if (sub.duration_ms && sub.duration_ms > 0) {
        state.subagentDurationMs += sub.duration_ms;
      }
      if (sub.usd?.total && sub.usd.total > 0) {
        state.subagentUsd += sub.usd.total;
      }
      const t = sub.agent_type || "agent";
      state.subagentByType.set(t, (state.subagentByType.get(t) ?? 0) + 1);
    }

    this.touch(state, this.activityFrom(env.capturedAt));
  }

  private subagentSummary(state: ConversationState): SessionSubagentSummary | undefined {
    if (state.subagentCount <= 0) {
      return undefined;
    }
    let dominantType = "";
    let best = 0;
    for (const [t, n] of state.subagentByType) {
      if (n > best) {
        best = n;
        dominantType = t;
      }
    }
    return {
      count: state.subagentCount,
      totalDurationMs: state.subagentDurationMs,
      totalUsd: state.subagentUsd,
      dominantType,
    };
  }

  private recordRecent(state: ConversationState, ev: CostEvent): void {
    if (ev.request_id) {
      const i = state.recent.findIndex((e) => e.request_id === ev.request_id);
      if (i >= 0) {
        state.recent[i] = ev;
        return;
      }
    }
    state.recent.push(ev);
    if (state.recent.length > MAX_RECENT_REQUESTS) {
      state.recent.shift();
      state.droppedRecent += 1;
    }
  }

  private accumulate(state: ConversationState, ev: CostEvent): void {
    if (ev.request_id) {
      if (state.counted.has(ev.request_id)) {
        return;
      }
      state.counted.add(ev.request_id);
    }
    state.totals.input += ev.tokens.input;
    state.totals.output += ev.tokens.output;
    state.totals.cache_read += ev.tokens.cache_read;
    state.totals.cache_write += ev.tokens.cache_write;
    state.totals.cost_total += ev.cost.total;
    state.costParts.input += ev.cost.input;
    state.costParts.cache_write += ev.cost.cache_write;

    const model = ev.model || "unknown";
    let mt = state.byModel.get(model);
    if (!mt) {
      mt = {
        model,
        model_priced: ev.model_priced,
        tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        cost_total: 0,
      };
      state.byModel.set(model, mt);
    }
    mt.model_priced = mt.model_priced || ev.model_priced;
    mt.tokens.input += ev.tokens.input;
    mt.tokens.output += ev.tokens.output;
    mt.tokens.cache_read += ev.tokens.cache_read;
    mt.tokens.cache_write += ev.tokens.cache_write;
    mt.cost_total += ev.cost.total;

    if (ev.tools) {
      state.toolsTotal += ev.tools.total ?? 0;
      for (const [name, n] of Object.entries(ev.tools.by_name ?? {})) {
        state.toolsByName.set(name, (state.toolsByName.get(name) ?? 0) + n);
      }
    }

    const rank: Record<string, number> = { exact: 3, reconciled: 2, estimate: 1 };
    if (!state.source || (rank[ev.source] ?? 0) < (rank[state.source] ?? 0)) {
      state.source = ev.source;
    }

    if (!state.startedAt || (parseTs(ev.ts) || Infinity) < (parseTs(state.startedAt) || Infinity)) {
      state.startedAt = ev.ts;
    }
    if (!state.updatedAt || (parseTs(ev.ts) || 0) >= (parseTs(state.updatedAt) || 0)) {
      state.updatedAt = ev.ts;
    }
  }

  private summarize(state: ConversationState): SessionSummary {
    const t = state.totals;
    const anyPriced = [...state.byModel.values()].some((m) => m.model_priced);
    const dominant = [...state.byModel.values()].sort((a, b) => b.cost_total - a.cost_total)[0];
    const signals: Signals = {
      cache_hit_rate: cacheHitRate(t.input, t.cache_read, t.cache_write),
      cache_miss_cost_share:
        t.cost_total > 0 ? (state.costParts.input + state.costParts.cache_write) / t.cost_total : 0,
      input_token_share: inputTokenShare(t.input, t.cache_read, t.cache_write),
      tier: dominant ? modelTier(dominant.model, dominant.model_priced) : "unknown",
      model_priced: anyPriced,
      tool_calls: state.toolsTotal,
    };
    const toolsByName = Object.fromEntries(state.toolsByName);
    return {
      session_id: state.key,
      tool: state.tool,
      source: state.source,
      started_at: state.startedAt,
      updated_at: state.updatedAt,
      totals: {
        input: t.input,
        output: t.output,
        cache_read: t.cache_read,
        cache_write: t.cache_write,
        cost_total: t.cost_total,
        currency: state.lastEvent?.cost.currency ?? "USD",
      },
      by_model: [...state.byModel.values()].sort((a, b) => b.cost_total - a.cost_total),
      tools:
        state.toolsTotal > 0
          ? { total: state.toolsTotal, by_name: Object.keys(toolsByName).length > 0 ? toolsByName : undefined }
          : undefined,
      signals,
    };
  }

  private view(state: ConversationState): ConversationView {
    return {
      key: state.key,
      tool: state.tool,
      summary: this.summarize(state),
      lastEvent: state.lastEvent,
      recent: state.recent,
      droppedRequests: state.droppedRecent,
      lastActivity: state.lastActivity,
      diff: state.diff,
      subagents: this.subagentSummary(state),
      vcs: state.vcs,
      prompts: this.promptGroups.groupsFor(state.key),
      droppedPrompts: this.promptGroups.droppedFor(state.key),
    };
  }

  /** Key of the most-recently-active conversation (debounced), or undefined if empty. */
  get activeKey(): string | undefined {
    return this.activeKeyRef;
  }

  private stateForKey(key: string | undefined): ConversationState | undefined {
    return key ? this.byKey.get(key) : undefined;
  }

  private get display(): ConversationState | undefined {
    return this.stateForKey(this.displayKey);
  }

  /** Locally-accumulated session summary for the displayed conversation. */
  get displaySummary(): SessionSummary | undefined {
    const d = this.display;
    return d ? this.summarize(d) : undefined;
  }

  /** Latest single request for the displayed conversation. */
  get displayLastEvent(): CostEvent | undefined {
    return this.display?.lastEvent;
  }

  /** Recent turns (oldest first) for the displayed conversation. */
  get displayRecent(): CostEvent[] {
    return this.display?.recent ?? [];
  }

  /** @deprecated Use displaySummary — kept for gradual migration. */
  get activeSummary(): SessionSummary | undefined {
    return this.displaySummary;
  }

  /** @deprecated Use displayLastEvent */
  get activeLastEvent(): CostEvent | undefined {
    return this.displayLastEvent;
  }

  /** @deprecated Use displayRecent */
  get activeRecent(): CostEvent[] {
    return this.displayRecent;
  }

  viewForKey(key: string): ConversationView | undefined {
    const s = this.byKey.get(key);
    return s ? this.view(s) : undefined;
  }

  /** Every conversation seen, most-recently-active first (for the panel). */
  list(): ConversationView[] {
    return [...this.byKey.values()]
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .map((s) => this.view(s));
  }
}
