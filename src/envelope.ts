// Tolerant, defensive view of the CLI's v2 event envelope — the single payload
// shape every PromptConduit surface reads from ~/.promptconduit/events.jsonl.
// Mirrors cli/internal/envelope (Go) and platform types/envelope.ts; the
// contract is additive-only: readers ignore slugs and fields they don't know.
//
// Every accessor is guarded so one malformed field never throws, and a bad
// line yields null rather than aborting a stream. Lines with schema < 2 (the
// retired v1 shape) are skipped.

import { Cost, CostEvent, Signals, Tokens, ToolSummary } from "./types";

export const MIN_ENVELOPE_SCHEMA = 2;

/** The "vcs" enrichment slug (subset the extension renders). */
export interface VCSEnrichment {
  type?: string;
  repo?: string; // provider-relative slug, e.g. "promptconduit/cli"
  repo_url?: string;
  branch?: string;
  branch_url?: string;
  pr_url?: string;
  commit_hash?: string;
  commit_message?: string;
  remote_url?: string;
  is_worktree?: boolean;
  worktree_path?: string;
}

/** The "trace" enrichment slug. */
export interface TraceEnrichment {
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
}

/** The "diff" enrichment slug (turn-end working-tree stats vs HEAD). */
export interface DiffEnrichment {
  files_changed?: number;
  insertions?: number;
  deletions?: number;
}

/** The "subagent" enrichment slug (SubagentStart/SubagentStop). */
export interface SubagentEnrichment {
  agent_id?: string;
  agent_type?: string;
  /** "start" or "stop". */
  phase?: string;
  concurrent?: number;
  duration_ms?: number;
  requests?: number;
  model?: string;
  tokens?: Partial<Tokens>;
  usd?: Partial<Cost>;
}

/** One normalized tool call inside the "tools" enrichment slug. */
export interface ToolsEnrichmentCall {
  name?: string;
  ok?: boolean;
  duration_ms?: number;
  mcp_server?: string;
  skill?: string;
  agent_type?: string;
}

/** The "tools" enrichment slug (PostToolUse / PostToolBatch / PostToolUseFailure). */
export interface ToolsEnrichment {
  total?: number;
  failed?: number;
  calls?: ToolsEnrichmentCall[];
}

/** The "env" enrichment slug (where the event was produced). */
export interface EnvEnrichment {
  host?: string;
  os?: string;
  os_version?: string;
  arch?: string;
  cwd?: string;
}

/** One priced request inside the "cost" enrichment slug. */
interface CostRequestSlug {
  request_id?: string;
  conversation_id?: string;
  model?: string;
  model_priced?: boolean;
  source?: string;
  ts?: string;
  tokens?: Partial<Tokens>;
  usd?: Partial<Cost>;
  tools?: ToolSummary;
  signals?: Signals;
}

/** The tool's raw hook payload (fields the extension reads). */
export interface RawEventPayload {
  session_id?: string;
  conversation_id?: string;
  hook_event_name?: string;
  model?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  tool_calls?: unknown;
  agent_id?: string;
  agent_type?: string;
  permission_mode?: string;
  prompt?: string;
  cwd?: string;
  [k: string]: unknown;
}

export interface EnvelopeV2 {
  schema: number;
  eventId: string;
  sessionId: string;
  promptId: string;
  tool: string;
  hookEvent: string;
  capturedAt: string;
  raw: RawEventPayload;
  vcs: VCSEnrichment;
  trace: TraceEnrichment;
  /** Raw enrichments map for slugs without a typed accessor. */
  enrichments: Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Parse one JSONL line into an EnvelopeV2. Returns null for blanks, malformed
 * JSON, non-objects, or pre-v2 lines so a single bad line never breaks a stream.
 */
export function parseEnvelopeV2(line: string): EnvelopeV2 | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const rec = obj(rawJson);
  if (num(rec.schema, 0) < MIN_ENVELOPE_SCHEMA) return null;

  const enrichments = obj(rec.enrichments);
  const raw = obj(rec.raw_event) as RawEventPayload;
  const vcsSrc = obj(enrichments.vcs);
  const commit = obj(vcsSrc.commit);
  const worktree = obj(vcsSrc.worktree);
  const pr = obj(vcsSrc.pr);
  const traceSrc = obj(enrichments.trace);

  return {
    schema: num(rec.schema),
    eventId: str(rec.event_id),
    sessionId: str(rec.session_id),
    promptId: str(rec.prompt_id),
    tool: str(rec.tool),
    hookEvent: str(rec.hook_event),
    capturedAt: str(rec.captured_at),
    raw,
    vcs: {
      type: str(vcsSrc.type) || undefined,
      repo: str(vcsSrc.repo) || undefined,
      repo_url: str(vcsSrc.repo_url) || undefined,
      branch: str(vcsSrc.branch) || undefined,
      branch_url: str(vcsSrc.branch_url) || undefined,
      pr_url: str(pr.url) || undefined,
      commit_hash: str(commit.hash) || undefined,
      commit_message: str(commit.message) || undefined,
      remote_url: str(vcsSrc.remote_url) || undefined,
      is_worktree: worktree.is_worktree === true || undefined,
      worktree_path: str(worktree.path) || undefined,
    },
    trace: {
      trace_id: str(traceSrc.trace_id) || undefined,
      span_id: str(traceSrc.span_id) || undefined,
      parent_span_id: str(traceSrc.parent_span_id) || undefined,
    },
    enrichments,
  };
}

function diffSlug(src: Record<string, unknown>): DiffEnrichment | undefined {
  if (!src || Object.keys(src).length === 0) {
    return undefined;
  }
  return {
    files_changed: num(src.files_changed) || undefined,
    insertions: num(src.insertions) || undefined,
    deletions: num(src.deletions) || undefined,
  };
}

function subagentSlug(src: Record<string, unknown>): SubagentEnrichment | undefined {
  if (!src || Object.keys(src).length === 0) {
    return undefined;
  }
  const tokens = obj(src.tokens);
  const usd = obj(src.usd);
  return {
    agent_id: str(src.agent_id) || undefined,
    agent_type: str(src.agent_type) || undefined,
    phase: str(src.phase) || undefined,
    concurrent: num(src.concurrent) || undefined,
    duration_ms: num(src.duration_ms) || undefined,
    requests: num(src.requests) || undefined,
    model: str(src.model) || undefined,
    tokens:
      Object.keys(tokens).length > 0
        ? {
            input: num(tokens.input),
            output: num(tokens.output),
            cache_read: num(tokens.cache_read),
            cache_write: num(tokens.cache_write),
          }
        : undefined,
    usd:
      Object.keys(usd).length > 0
        ? {
            input: num(usd.input),
            output: num(usd.output),
            cache_read: num(usd.cache_read),
            cache_write: num(usd.cache_write),
            total: num(usd.total),
            currency: str(usd.currency) || "USD",
          }
        : undefined,
  };
}

function toolsSlug(src: Record<string, unknown>): ToolsEnrichment | undefined {
  if (!src || Object.keys(src).length === 0) {
    return undefined;
  }
  const calls = Array.isArray(src.calls)
    ? src.calls.map((c) => {
        const call = obj(c);
        return {
          name: str(call.name) || undefined,
          ok: call.ok === true ? true : call.ok === false ? false : undefined,
          duration_ms: num(call.duration_ms) || undefined,
          mcp_server: str(call.mcp_server) || undefined,
          skill: str(call.skill) || undefined,
          agent_type: str(call.agent_type) || undefined,
        };
      })
    : undefined;
  return {
    total: num(src.total) || undefined,
    failed: num(src.failed) || undefined,
    calls,
  };
}

function envSlug(src: Record<string, unknown>): EnvEnrichment | undefined {
  if (!src || Object.keys(src).length === 0) {
    return undefined;
  }
  return {
    host: str(src.host) || undefined,
    os: str(src.os) || undefined,
    os_version: str(src.os_version) || undefined,
    arch: str(src.arch) || undefined,
    cwd: str(src.cwd) || undefined,
  };
}

/** Read the `diff` enrichment slug; undefined when absent or empty. */
export function diffFrom(env: EnvelopeV2): DiffEnrichment | undefined {
  return diffSlug(obj(env.enrichments.diff));
}

/** Read the `subagent` enrichment slug; undefined when absent or empty. */
export function subagentFrom(env: EnvelopeV2): SubagentEnrichment | undefined {
  return subagentSlug(obj(env.enrichments.subagent));
}

/** Read the `tools` enrichment slug; undefined when absent or empty. */
export function toolsFrom(env: EnvelopeV2): ToolsEnrichment | undefined {
  return toolsSlug(obj(env.enrichments.tools));
}

/** Read the `env` enrichment slug; undefined when absent or empty. */
export function envFrom(env: EnvelopeV2): EnvEnrichment | undefined {
  return envSlug(obj(env.enrichments.env));
}

// Basename of a path without importing node:path (keeps this module usable in
// pure unit tests and the webview bundle).
function basename(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const i = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return i >= 0 ? norm.slice(i + 1) : norm;
}

/**
 * Extract the priced requests from an envelope's `cost` enrichment as
 * CostEvent records (the extension's internal cost model). Empty for events
 * without a cost slug. Each request keeps its own request_id for dedup —
 * exactly the semantics of the retired `cost watch --json` feed.
 */
export function costEventsFrom(env: EnvelopeV2): CostEvent[] {
  const cost = obj(env.enrichments.cost);
  const requests = Array.isArray(cost.requests) ? cost.requests : [];
  const out: CostEvent[] = [];
  for (const r of requests) {
    const req = obj(r) as CostRequestSlug;
    const tokens = obj(req.tokens);
    const usd = obj(req.usd);
    const requestId = str(req.request_id);
    if (!requestId) continue;
    const ev: CostEvent = {
      tool: env.tool,
      session_id: env.sessionId || str(env.raw.session_id),
      conversation_id: str(req.conversation_id) || undefined,
      request_id: requestId,
      ts: str(req.ts) || env.capturedAt,
      model: str(req.model),
      model_priced: req.model_priced === true,
      source: str(req.source),
      tokens: {
        input: num(tokens.input),
        output: num(tokens.output),
        cache_read: num(tokens.cache_read),
        cache_write: num(tokens.cache_write),
      },
      cost: {
        input: num(usd.input),
        output: num(usd.output),
        cache_read: num(usd.cache_read),
        cache_write: num(usd.cache_write),
        total: num(usd.total),
        currency: str(usd.currency) || "USD",
      },
      cwd_base: env.raw.cwd ? basename(str(env.raw.cwd)) : "",
      tools: req.tools && typeof req.tools === "object" ? req.tools : undefined,
      signals: req.signals && typeof req.signals === "object" ? req.signals : undefined,
    };
    if (!ev.session_id) continue;
    out.push(ev);
  }
  return out;
}
