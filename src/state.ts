// Per-conversation cost state. Pure logic — no vscode import — so it can be
// unit-tested and reused. Conversations are keyed by Cursor's per-tab
// `conversation_id`, falling back to `session_id` (Claude Code).
//
// Since envelope v2 the store also ACCUMULATES the session summary locally
// (totals, per-model breakdown, tool counts, recomputed signals) from the
// per-request cost events — the CLI no longer streams a session_summary
// record. The status bar renders the MOST-RECENTLY-ACTIVE conversation; the
// breakdown panel renders every conversation via list().

import { CostEvent, ModelTotal, SessionSummary, Signals, Tokens } from "./types";

// Bound on the per-conversation recent-turn history retained for the panel.
const MAX_RECENT = 50;

/** Everything the panel needs to render one conversation. */
export interface ConversationView {
  key: string;
  tool: string;
  summary: SessionSummary;
  lastEvent?: CostEvent;
  /** Recent turns, oldest first. */
  recent: CostEvent[];
  lastActivity: number;
}

// Per-conversation accumulated cost state.
interface ConversationState {
  key: string;
  tool: string;
  // Latest single request observed for this conversation.
  lastEvent?: CostEvent;
  // Bounded, request_id-deduped history of recent turns (oldest first).
  recent: CostEvent[];
  // request_ids already folded into the running totals (Cursor emits two
  // events per generation; the CLI dedups too, but we guard here as well).
  counted: Set<string>;
  totals: Tokens & { cost_total: number };
  costParts: { input: number; cache_write: number };
  byModel: Map<string, ModelTotal>;
  toolsTotal: number;
  toolsByName: Map<string, number>;
  source: string;
  startedAt: string;
  updatedAt: string;
  // Newest activity time seen for this conversation, used to pick the active
  // one. Epoch-ms from the record's ts; records with no parseable timestamp
  // fall back to a small arrival-order seq.
  lastActivity: number;
}

// Parse an ISO timestamp to epoch ms; NaN when absent/unparseable.
function parseTs(ts: string | undefined): number {
  if (!ts) {
    return NaN;
  }
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? NaN : ms;
}

// ---- session-signal math (mirrors cli/internal/cost/event.go) ----

function cacheHitRate(input: number, cacheRead: number, cacheWrite: number): number {
  const denom = cacheRead + cacheWrite + input;
  return denom > 0 ? cacheRead / denom : 0;
}

function inputTokenShare(input: number, cacheRead: number, cacheWrite: number): number {
  const denom = input + cacheRead + cacheWrite;
  return denom > 0 ? input / denom : 0;
}

// Coarse model-cost tier from the name (mirrors the CLI's modelTier).
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
 * absent that, by session (Claude Code). It exposes getters scoped to the
 * ACTIVE conversation — the key with the newest activity — plus list() for the
 * multi-session breakdown panel.
 */
export class ConversationStore {
  private readonly byKey = new Map<string, ConversationState>();
  private activeKeyRef: string | undefined;
  private newestActivity = -Infinity;
  // Monotonic fallback so records with no usable timestamp still order by
  // arrival (most recent wins).
  private seq = 0;

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
        counted: new Set(),
        totals: { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_total: 0 },
        costParts: { input: 0, cache_write: 0 },
        byModel: new Map(),
        toolsTotal: 0,
        toolsByName: new Map(),
        source: "",
        startedAt: "",
        updatedAt: "",
        lastActivity: -Infinity,
      };
      this.byKey.set(key, state);
    }
    return state;
  }

  // Resolve a record's activity time, falling back to arrival order when the
  // record has no parseable timestamp so newer records still win.
  private activityFrom(ts: string | undefined): number {
    const parsed = parseTs(ts);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
    // Tiny monotonic increment keeps arrival ordering without colliding with
    // real epoch-ms values.
    this.seq += 1;
    return this.seq;
  }

  // Mark a conversation active if its activity is the newest we've seen. Ties
  // (and equal timestamps) keep the most-recent caller as active.
  private touch(state: ConversationState, activity: number): void {
    if (activity >= state.lastActivity) {
      state.lastActivity = activity;
    }
    if (state.lastActivity >= this.newestActivity) {
      this.newestActivity = state.lastActivity;
      this.activeKeyRef = state.key;
    }
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

  // Append (or replace, by request_id) into the bounded recent history.
  private recordRecent(state: ConversationState, ev: CostEvent): void {
    if (ev.request_id) {
      const i = state.recent.findIndex((e) => e.request_id === ev.request_id);
      if (i >= 0) {
        state.recent[i] = ev;
        return;
      }
    }
    state.recent.push(ev);
    if (state.recent.length > MAX_RECENT) {
      state.recent.shift();
    }
  }

  // Fold a request into the running session totals, once per request_id.
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

    // Session source is the worst case across events (estimate < reconciled < exact).
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

  // Build the SessionSummary view from the accumulated state. Signals are the
  // same formulas the CLI applies, re-applied to summed tokens/costs; tier is
  // the costliest model's tier.
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
      lastActivity: state.lastActivity,
    };
  }

  /** Key of the most-recently-active conversation, or undefined if empty. */
  get activeKey(): string | undefined {
    return this.activeKeyRef;
  }

  private get active(): ConversationState | undefined {
    return this.activeKeyRef ? this.byKey.get(this.activeKeyRef) : undefined;
  }

  /** Locally-accumulated session summary for the active conversation. */
  get activeSummary(): SessionSummary | undefined {
    const a = this.active;
    return a ? this.summarize(a) : undefined;
  }

  /** Latest single request for the active conversation. */
  get activeLastEvent(): CostEvent | undefined {
    return this.active?.lastEvent;
  }

  /** Recent turns (oldest first) for the active conversation. */
  get activeRecent(): CostEvent[] {
    return this.active?.recent ?? [];
  }

  /** Every conversation seen, most-recently-active first (for the panel). */
  list(): ConversationView[] {
    return [...this.byKey.values()]
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .map((s) => this.view(s));
  }
}
