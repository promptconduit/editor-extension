// Per-conversation cost state. Pure logic — no vscode import — so it can be
// unit-tested and reused. The status bar renders the MOST-RECENTLY-ACTIVE
// conversation (issue #7): Cursor emits a per-tab `conversation_id`, while
// Claude Code does not, so we fall back to `session_id` as the key.

import { CostEvent, SessionSummary } from "./types";

// Bound on the per-conversation recent-turn history retained for the panel.
// Matches the previous single-session cap so behaviour is unchanged per tab.
const MAX_RECENT = 50;

// Per-conversation accumulated cost state.
interface ConversationState {
  key: string;
  // Latest single request observed for this conversation.
  lastEvent?: CostEvent;
  // Latest session summary observed for this conversation.
  summary?: SessionSummary;
  // Bounded, request_id-deduped history of recent turns (oldest first). The CLI
  // dedups by request_id too, but Cursor emits two events per generation, so we
  // guard here as well.
  recent: CostEvent[];
  // Newest activity timestamp seen (event ts / summary updated_at), ms epoch.
  // Used to pick the active conversation. Falls back to arrival order when a
  // record carries an unparseable/absent timestamp.
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

/**
 * ConversationStore keeps cost state keyed by conversation (Cursor per-tab) or,
 * absent that, by session (Claude Code). It exposes getters scoped to the
 * ACTIVE conversation — the key with the newest activity — so the status bar can
 * follow whichever agent tab most recently produced a record.
 */
export class ConversationStore {
  private readonly byKey = new Map<string, ConversationState>();
  private activeKeyRef: string | undefined;
  private newestActivity = -Infinity;
  // Monotonic fallback so records with no usable timestamp still order by
  // arrival (most recent wins), matching the prior single-session behaviour.
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
      state = { key, recent: [], lastActivity: -Infinity };
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
    state.lastEvent = ev;
    this.recordRecent(state, ev);
    this.touch(state, this.activityFrom(ev.ts));
  }

  recordSummary(s: SessionSummary): void {
    const key = ConversationStore.key(s);
    const state = this.ensure(key);
    state.summary = s;
    this.touch(state, this.activityFrom(s.updated_at));
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

  /** Key of the most-recently-active conversation, or undefined if empty. */
  get activeKey(): string | undefined {
    return this.activeKeyRef;
  }

  private get active(): ConversationState | undefined {
    return this.activeKeyRef ? this.byKey.get(this.activeKeyRef) : undefined;
  }

  /** Latest session summary for the active conversation. */
  get activeSummary(): SessionSummary | undefined {
    return this.active?.summary;
  }

  /** Latest single request for the active conversation. */
  get activeLastEvent(): CostEvent | undefined {
    return this.active?.lastEvent;
  }

  /** Recent turns (oldest first) for the active conversation. */
  get activeRecent(): CostEvent[] {
    return this.active?.recent ?? [];
  }
}
