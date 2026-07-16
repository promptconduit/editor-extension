// Per-PROMPT correlation store. Pure logic — no vscode import — so it can be
// unit-tested and reused. Groups envelope events (UserPromptSubmit, tool
// events, subagent start/stop, Stop) into one PromptGroup per prompt so the
// cost panel can show spend, tools, subagents, permissions, and raw JSON for
// each prompt individually.
//
// Conversations are keyed the same way as ConversationStore (state.ts):
// Cursor's per-tab `conversation_id`, falling back to session id.
//
// Correlation is by `prompt_id` when the CLI provides one (the group id IS the
// prompt id), with arrival-order fallbacks: the currently-open group, the
// last-closed group (for tool results trailing a Stop by < 30s), and a
// per-conversation "preamble" group for events before the first prompt. A Stop
// with no matching prompt opens an "uncaptured" group — that is Cursor's
// NORMAL generation-per-prompt path, not an error.

import { EnvelopeV2, subagentFrom, toolsFrom } from "./envelope";
import { CostEvent, Tokens } from "./types";

/** One tool call attributed to a prompt (from the `tools` enrichment slug). */
export interface PromptToolCall {
  name: string;
  ok: boolean;
  durationMs?: number;
  mcpServer?: string;
  skill?: string;
  agentType?: string;
}

/** One subagent run attributed to a prompt (SubagentStart/Stop join). */
export interface PromptSubagent {
  agentId: string;
  agentType: string;
  startedAt?: string;
  endedAt?: string;
  concurrent?: number;
  durationMs?: number;
  requests?: number;
  model?: string;
  tokens?: Tokens;
  usdTotal?: number;
  /** Stop arrived with no matching start; startedAt is back-computed when possible. */
  orphanStop?: boolean;
  /** Worktree the subagent ran in (vcs.worktree), when it ran in one. */
  worktreePath?: string;
}

/** Pretty-printed envelope JSON kept for the raw-inspector view. */
export interface PromptRawEvent {
  eventId: string;
  hookEvent: string;
  capturedAt: string;
  /** Absent once truncJson was evicted by the global raw budget. */
  json?: string;
  truncated: boolean;
  evicted: boolean;
}

export interface PromptGroup {
  id: string;
  /**
   * "prompt" = opened by a UserPromptSubmit; "uncaptured" = a Stop with no
   * prompt (Cursor's NORMAL path); "preamble" = events before the first prompt.
   */
  kind: "prompt" | "uncaptured" | "preamble";
  promptText?: string;
  permissionMode?: string;
  promptStats?: { chars?: number; words?: number; hasAttachments?: boolean };
  interrupted?: boolean;
  /** The turn ended with StopFailure rather than a clean Stop. */
  stopFailed?: boolean;
  /** Worktree the turn's events ran in (vcs.worktree), when they ran in one. */
  worktreePath?: string;
  startedAt?: string;
  endedAt?: string;
  turnDurationMs?: number;
  requests: CostEvent[];
  toolCalls: PromptToolCall[];
  subagents: PromptSubagent[];
  permissions: { decision: string; toolName?: string; mcpServer?: string }[];
  rawEvents: PromptRawEvent[];
  /** Bumped on every mutation (webview diffing). */
  rev: number;
  /** Tool calls silently dropped past the per-group cap. */
  droppedToolCalls?: number;
}

// ---- caps (arrival-order, content-bounded) ----

/** Per-conversation dedup seen-set bound (FIFO evict). */
const SEEN_CAP = 8000;
/** A tool event trailing the last closed group by less than this attaches to it. */
const TRAIL_MS = 30_000;
const PROMPT_TEXT_MAX = 2000;
const TOOL_CALLS_CAP = 500;
const SUBAGENTS_CAP = 100;
const RAW_EVENTS_CAP = 60;
const RAW_JSON_MAX = 32 * 1024;
/** Global budget for stored raw JSON across ALL conversations. */
const RAW_BUDGET = 8 * 1024 * 1024;
const GROUPS_CAP = 300;

// ---- safe accessors (everything off the wire is `unknown`) ----

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function numOpt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function parseTs(ts: string | undefined): number {
  if (!ts) return NaN;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? NaN : ms;
}

// Per-conversation correlation state.
interface Conversation {
  key: string;
  /** Group ids, append order (what groupsFor returns). */
  order: string[];
  byId: Map<string, PromptGroup>;
  openId?: string;
  lastClosedId?: string;
  seen: Set<string>;
  seenOrder: string[];
  dropped: number;
}

/** The conversation key of an envelope: conversation_id, else session id. */
function conversationKeyOf(env: EnvelopeV2): string {
  const cid = str(env.raw.conversation_id);
  if (cid) return cid;
  return env.sessionId || str(env.raw.session_id);
}

/** The worktree an event ran in (vcs.worktree), or undefined outside one. */
function worktreeOf(env: EnvelopeV2): string | undefined {
  return env.vcs.is_worktree ? env.vcs.worktree_path : undefined;
}

/**
 * PromptGroupStore correlates envelope events into per-prompt groups per
 * conversation. Everything uses ARRIVAL order, not timestamps; re-ingesting
 * the same lines (log rotation) is idempotent via per-conversation eventId
 * dedup.
 */
export class PromptGroupStore {
  private readonly convs = new Map<string, Conversation>();
  /** Every group across all conversations, creation order (raw-budget eviction). */
  private groupOrder: PromptGroup[] = [];
  private rawBytes = 0;
  /** retainRaw:false skips raw-JSON storage entirely (metadata-only consumers). */
  constructor(private readonly opts: { retainRaw?: boolean } = {}) {}

  /** Ingest one envelope; costEvents = costEventsFrom(env), passed by the caller. */
  record(env: EnvelopeV2, costEvents: CostEvent[]): void {
    const key = conversationKeyOf(env);
    if (!key) return;
    const conv = this.ensure(key);

    // Rule 1: dedup by eventId per conversation (bounded, FIFO evict).
    if (env.eventId) {
      if (conv.seen.has(env.eventId)) return;
      conv.seen.add(env.eventId);
      conv.seenOrder.push(env.eventId);
      if (conv.seenOrder.length > SEEN_CAP) {
        conv.seen.delete(conv.seenOrder.shift()!);
      }
    }

    switch (env.hookEvent) {
      case "UserPromptSubmit":
        this.onPrompt(conv, env);
        break;
      case "PostToolUse":
      case "PostToolBatch":
      case "PostToolUseFailure":
        this.onTools(conv, env);
        break;
      case "SubagentStart":
        this.onSubagentStart(conv, env);
        break;
      case "SubagentStop":
        this.onSubagentStop(conv, env);
        break;
      case "Stop":
      case "stop": // Cursor emits lowercase stop for its per-prompt generations
      case "StopFailure":
        this.onStop(conv, env, costEvents);
        break;
      case "PermissionRequest":
      case "PermissionDenied":
        this.onPermission(conv, env);
        break;
      default:
        // Other events (SessionStart, PreToolUse, …) are not routed to groups.
        break;
    }
  }

  /** Groups of a conversation in append order. */
  groupsFor(conversationKey: string): PromptGroup[] {
    const conv = this.convs.get(conversationKey);
    if (!conv) return [];
    const out: PromptGroup[] = [];
    for (const id of conv.order) {
      const g = conv.byId.get(id);
      if (g) out.push(g);
    }
    return out;
  }

  /** How many groups were evicted past the per-conversation cap. */
  droppedFor(conversationKey: string): number {
    return this.convs.get(conversationKey)?.dropped ?? 0;
  }

  // ---- internals ----

  private ensure(key: string): Conversation {
    let conv = this.convs.get(key);
    if (!conv) {
      conv = { key, order: [], byId: new Map(), seen: new Set(), seenOrder: [], dropped: 0 };
      this.convs.set(key, conv);
    }
    return conv;
  }

  // Rule 2: promptId from the envelope, else (Stop only) the turn slug's prompt_id.
  private pidOf(env: EnvelopeV2): string | undefined {
    if (env.promptId) return env.promptId;
    if (env.hookEvent === "Stop" || env.hookEvent === "stop" || env.hookEvent === "StopFailure") {
      const pid = str(obj(env.enrichments.turn).prompt_id);
      if (pid) return pid;
    }
    return undefined;
  }

  private newGroup(id: string, kind: PromptGroup["kind"]): PromptGroup {
    return {
      id,
      kind,
      requests: [],
      toolCalls: [],
      subagents: [],
      permissions: [],
      rawEvents: [],
      rev: 0,
    };
  }

  // Rule 8: append to the conversation and evict past the per-conversation cap.
  private addGroup(conv: Conversation, g: PromptGroup): PromptGroup {
    conv.byId.set(g.id, g);
    conv.order.push(g.id);
    this.groupOrder.push(g);
    while (conv.order.length > GROUPS_CAP) {
      const oldId = conv.order.shift()!;
      const old = conv.byId.get(oldId);
      conv.byId.delete(oldId);
      conv.dropped += 1;
      if (old) {
        for (const re of old.rawEvents) {
          if (re.json !== undefined) {
            this.rawBytes -= re.json.length;
            re.json = undefined;
            re.evicted = true;
          }
        }
        const i = this.groupOrder.indexOf(old);
        if (i >= 0) this.groupOrder.splice(i, 1);
      }
      if (conv.openId === oldId) conv.openId = undefined;
      if (conv.lastClosedId === oldId) conv.lastClosedId = undefined;
    }
    return g;
  }

  private closeGroup(conv: Conversation, g: PromptGroup): void {
    if (conv.openId === g.id) conv.openId = undefined;
    conv.lastClosedId = g.id;
  }

  // Rule 4 targeting: pid match → open group → last-closed within 30s → preamble.
  private target(conv: Conversation, env: EnvelopeV2): PromptGroup {
    const pid = this.pidOf(env);
    if (pid) {
      const g = conv.byId.get(pid);
      if (g) return g;
    }
    if (conv.openId) {
      const g = conv.byId.get(conv.openId);
      if (g) return g;
    }
    const lastClosed = conv.lastClosedId ? conv.byId.get(conv.lastClosedId) : undefined;
    if (lastClosed && this.withinTrail(env.capturedAt, lastClosed.endedAt)) return lastClosed;
    return this.ensurePreamble(conv);
  }

  // capturedAt − endedAt < 30s; unparseable timestamps count as within.
  private withinTrail(capturedAt: string, endedAt: string | undefined): boolean {
    const a = parseTs(capturedAt);
    const b = parseTs(endedAt);
    if (Number.isNaN(a) || Number.isNaN(b)) return true;
    return a - b < TRAIL_MS;
  }

  private ensurePreamble(conv: Conversation): PromptGroup {
    const id = "pre:" + conv.key;
    const existing = conv.byId.get(id);
    if (existing) return existing;
    return this.addGroup(conv, this.newGroup(id, "preamble"));
  }

  // Rule 3: a prompt closes any open group (marking it interrupted when this
  // prompt's slug says is_interrupt) and opens a new "prompt" group.
  private onPrompt(conv: Conversation, env: EnvelopeV2): void {
    if (conv.openId) {
      const open = conv.byId.get(conv.openId);
      if (open) {
        open.endedAt = env.capturedAt;
        if (obj(env.enrichments.prompt).is_interrupt === true) open.interrupted = true;
        open.rev += 1;
        this.closeGroup(conv, open);
      } else {
        conv.openId = undefined;
      }
    }

    const pid = this.pidOf(env);
    const gid = pid ?? "t:" + env.eventId;
    let g = conv.byId.get(gid);
    if (!g) g = this.addGroup(conv, this.newGroup(gid, "prompt"));

    const promptText = str(env.raw.prompt);
    if (promptText) g.promptText = promptText.slice(0, PROMPT_TEXT_MAX);
    const mode = str(env.raw.permission_mode);
    if (mode) g.permissionMode = mode;
    const slug = obj(env.enrichments.prompt);
    if (Object.keys(slug).length > 0) {
      g.promptStats = {
        chars: numOpt(slug.chars),
        words: numOpt(slug.words),
        hasAttachments: slug.has_attachments === true || undefined,
      };
    }
    g.startedAt = env.capturedAt;
    const wt = worktreeOf(env);
    if (wt) g.worktreePath = wt;
    conv.openId = g.id;
    g.rev += 1;
    this.attachRaw(g, env);
  }

  private onTools(conv: Conversation, env: EnvelopeV2): void {
    const g = this.target(conv, env);
    const wt = worktreeOf(env);
    if (wt) g.worktreePath = wt;
    const calls = toolsFrom(env)?.calls ?? [];
    for (const c of calls) {
      if (g.toolCalls.length >= TOOL_CALLS_CAP) {
        g.droppedToolCalls = (g.droppedToolCalls ?? 0) + 1;
        continue;
      }
      g.toolCalls.push({
        name: c.name ?? "",
        ok: c.ok ?? env.hookEvent !== "PostToolUseFailure",
        durationMs: c.duration_ms,
        mcpServer: c.mcp_server,
        skill: c.skill,
        agentType: c.agent_type,
      });
    }
    g.rev += 1;
    this.attachRaw(g, env);
  }

  // Rule 5: upsert the start record by agent_id into the target group.
  private onSubagentStart(conv: Conversation, env: EnvelopeV2): void {
    const g = this.target(conv, env);
    const slug = subagentFrom(env);
    const agentId = slug?.agent_id || str(env.raw.agent_id);
    if (agentId) {
      let rec = g.subagents.find((s) => s.agentId === agentId);
      if (!rec && g.subagents.length < SUBAGENTS_CAP) {
        rec = { agentId, agentType: "" };
        g.subagents.push(rec);
      }
      if (rec) {
        rec.agentType = slug?.agent_type || str(env.raw.agent_type) || rec.agentType;
        rec.startedAt = env.capturedAt;
        if (slug?.concurrent !== undefined) rec.concurrent = slug.concurrent;
        const wt = worktreeOf(env);
        if (wt) rec.worktreePath = wt;
      }
    }
    g.rev += 1;
    this.attachRaw(g, env);
  }

  // Rule 5: pair the stop with its start (target group → open group → last 3
  // groups); an orphan stop becomes its own record with startedAt back-computed.
  private onSubagentStop(conv: Conversation, env: EnvelopeV2): void {
    const g = this.target(conv, env);
    const slug = subagentFrom(env);
    const agentId = slug?.agent_id || str(env.raw.agent_id);

    const candidates: PromptGroup[] = [g];
    if (conv.openId) {
      const open = conv.byId.get(conv.openId);
      if (open && !candidates.includes(open)) candidates.push(open);
    }
    for (const id of conv.order.slice(-3).reverse()) {
      const cand = conv.byId.get(id);
      if (cand && !candidates.includes(cand)) candidates.push(cand);
    }

    let host = g;
    let rec: PromptSubagent | undefined;
    if (agentId) {
      for (const cand of candidates) {
        const found =
          cand.subagents.find((s) => s.agentId === agentId && s.endedAt === undefined) ??
          cand.subagents.find((s) => s.agentId === agentId);
        if (found) {
          host = cand;
          rec = found;
          break;
        }
      }
    }
    if (!rec) {
      // Orphan stop: synthesize the record; back-compute startedAt when possible.
      rec = { agentId: agentId || "", agentType: "", orphanStop: true };
      const end = parseTs(env.capturedAt);
      if (!Number.isNaN(end) && slug?.duration_ms !== undefined) {
        rec.startedAt = new Date(end - slug.duration_ms).toISOString();
      }
      if (host.subagents.length < SUBAGENTS_CAP) host.subagents.push(rec);
    }

    rec.agentType = slug?.agent_type || str(env.raw.agent_type) || rec.agentType;
    if (slug?.duration_ms !== undefined) rec.durationMs = slug.duration_ms;
    if (slug?.requests !== undefined) rec.requests = slug.requests;
    if (slug?.model) rec.model = slug.model;
    if (slug?.tokens) {
      rec.tokens = {
        input: slug.tokens.input ?? 0,
        output: slug.tokens.output ?? 0,
        cache_read: slug.tokens.cache_read ?? 0,
        cache_write: slug.tokens.cache_write ?? 0,
      };
    }
    if (slug?.usd?.total !== undefined) rec.usdTotal = slug.usd.total;
    rec.endedAt = env.capturedAt;
    const wt = worktreeOf(env);
    if (wt) rec.worktreePath = wt;

    host.rev += 1;
    this.attachRaw(host, env);
  }

  // Rule 6: a Stop closes its prompt's group, or opens an "uncaptured" one
  // (Cursor's normal generation-per-prompt path). StopFailure closes the same
  // way but marks the group failed.
  private onStop(conv: Conversation, env: EnvelopeV2, costEvents: CostEvent[]): void {
    const pid = this.pidOf(env);
    let g = pid ? conv.byId.get(pid) : undefined;
    if (!g && conv.openId) g = conv.byId.get(conv.openId);
    if (!g) g = this.addGroup(conv, this.newGroup("r:" + env.eventId, "uncaptured"));

    for (const ce of costEvents) {
      if (ce.request_id && g.requests.some((r) => r.request_id === ce.request_id)) continue;
      g.requests.push(ce);
    }
    const turnDur = numOpt(obj(env.enrichments.turn).duration_ms);
    if (turnDur !== undefined) g.turnDurationMs = turnDur;
    if (env.hookEvent === "StopFailure") g.stopFailed = true;
    const wt = worktreeOf(env);
    if (wt) g.worktreePath = wt;
    g.endedAt = env.capturedAt;
    this.closeGroup(conv, g);
    g.rev += 1;
    this.attachRaw(g, env);
  }

  private onPermission(conv: Conversation, env: EnvelopeV2): void {
    const g = this.target(conv, env);
    const slug = obj(env.enrichments.permission);
    g.permissions.push({
      decision: str(slug.decision) || (env.hookEvent === "PermissionDenied" ? "denied" : "requested"),
      toolName: str(slug.tool_name) || str(env.raw.tool_name) || undefined,
      mcpServer: str(slug.mcp_server) || undefined,
    });
    g.rev += 1;
    this.attachRaw(g, env);
  }

  // Rule 7: keep pretty-printed envelope JSON per routed event, truncated at
  // 32 KiB, capped at 60/group, under a global 8 MB budget (evict json from
  // the OLDEST groups first; metadata is never evicted). Skipped entirely for
  // retainRaw:false stores (e.g. the session graph, which never shows raw JSON
  // and would otherwise duplicate the cost panel's copy).
  private attachRaw(g: PromptGroup, env: EnvelopeV2): void {
    if (this.opts.retainRaw === false) return;
    if (g.rawEvents.length >= RAW_EVENTS_CAP) return;
    let json: string | undefined;
    let truncated = false;
    try {
      json = JSON.stringify(
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
      json = undefined; // circular / non-serializable — keep the metadata anyway
    }
    if (json !== undefined && json.length > RAW_JSON_MAX) {
      json = json.slice(0, RAW_JSON_MAX);
      truncated = true;
    }
    g.rawEvents.push({
      eventId: env.eventId,
      hookEvent: env.hookEvent,
      capturedAt: env.capturedAt,
      json,
      truncated,
      evicted: false,
    });
    if (json !== undefined) {
      this.rawBytes += json.length;
      this.enforceRawBudget();
    }
    g.rev += 1;
  }

  private enforceRawBudget(): void {
    if (this.rawBytes <= RAW_BUDGET) return;
    for (const g of this.groupOrder) {
      let changed = false;
      for (const re of g.rawEvents) {
        if (re.json === undefined) continue;
        this.rawBytes -= re.json.length;
        re.json = undefined;
        re.evicted = true;
        changed = true;
        if (this.rawBytes <= RAW_BUDGET) break;
      }
      if (changed) g.rev += 1;
      if (this.rawBytes <= RAW_BUDGET) return;
    }
  }
}
