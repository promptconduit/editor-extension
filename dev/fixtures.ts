// Shared sample data for unit tests, the webview preview, and `npm run dev`
// seeding. Realistic enough to exercise the cost logic (tips/signals/state) and
// the panels without running the CLI or a real AI session. All envelope lines
// are v2 (schema: 2) — the single payload shape everything reads.

import { CostEvent, SessionSummary } from "../src/types";

// ---------- cost model records (internal shapes) ----------

function ev(p: Partial<CostEvent> & Pick<CostEvent, "session_id" | "request_id" | "ts">): CostEvent {
  return {
    tool: "cursor",
    model: "claude-4.5-sonnet",
    model_priced: true,
    source: "exact",
    cwd_base: "promptconduit",
    tokens: { input: 8000, output: 1200, cache_read: 24000, cache_write: 1500 },
    cost: { input: 0.024, output: 0.018, cache_read: 0.0072, cache_write: 0.0056, total: 0.0548, currency: "USD" },
    ...p,
  };
}

// Two Cursor "tabs" (conversation_id) so the status bar's active-tab logic has
// something to follow; tab-B is newer, so it's the active one.
export const sampleEvents: CostEvent[] = [
  ev({ conversation_id: "tab-A", session_id: "s1", request_id: "a1", ts: "2026-06-27T17:00:00Z", model: "claude-4.5-opus" }),
  ev({ conversation_id: "tab-A", session_id: "s1", request_id: "a2", ts: "2026-06-27T17:01:00Z", model: "claude-4.5-opus" }),
  ev({ conversation_id: "tab-B", session_id: "s2", request_id: "b1", ts: "2026-06-27T17:05:00Z" }),
];

// A heavy session that trips every cost-reduction tip (low cache hit, lots of
// fresh input, premium tier, high tool volume, an unpriced model).
export const heavySummary: SessionSummary = {
  session_id: "s-heavy",
  tool: "claude-code",
  source: "exact",
  started_at: "2026-06-27T16:00:00Z",
  updated_at: "2026-06-27T17:10:00Z",
  totals: { input: 30000, output: 6000, cache_read: 5000, cache_write: 2000, cost_total: 0.92, currency: "USD" },
  by_model: [
    { model: "claude-4.5-opus", model_priced: true, tokens: { input: 30000, output: 6000, cache_read: 5000, cache_write: 2000 }, cost_total: 0.92 },
    { model: "composer-1", model_priced: false, tokens: { input: 4000, output: 800, cache_read: 0, cache_write: 0 }, cost_total: 0 },
  ],
  tools: { total: 52, by_name: { Read: 20, Bash: 18, Edit: 14 } },
  signals: {
    cache_hit_rate: 0.135,
    cache_miss_cost_share: 0.71,
    input_token_share: 0.81,
    tier: "premium",
    model_priced: true,
    tool_calls: 52,
  },
};

// A lean, well-cached session that should produce NO tips.
export const cleanSummary: SessionSummary = {
  session_id: "s-clean",
  tool: "cursor",
  source: "exact",
  started_at: "2026-06-27T16:00:00Z",
  updated_at: "2026-06-27T17:12:00Z",
  totals: { input: 3000, output: 2000, cache_read: 40000, cache_write: 1000, cost_total: 0.21, currency: "USD" },
  by_model: [
    { model: "claude-4.5-sonnet", model_priced: true, tokens: { input: 3000, output: 2000, cache_read: 40000, cache_write: 1000 }, cost_total: 0.21 },
  ],
  tools: { total: 6, by_name: { Read: 4, Edit: 2 } },
  signals: {
    cache_hit_rate: 0.91,
    cache_miss_cost_share: 0.18,
    input_token_share: 0.07,
    tier: "standard",
    model_priced: true,
    tool_calls: 6,
  },
};

// ---------- v2 envelope lines (events.jsonl) ----------

let eventSeq = 0;

interface EnvelopeOpts {
  sessionId?: string;
  promptId?: string;
  raw?: Record<string, unknown>;
  enrichments?: Record<string, unknown>;
  repo?: string;
  branch?: string;
  worktree?: boolean;
  cliVersion?: string;
}

/** Build one v2 events.jsonl line. */
export function v2Envelope(tool: string, hookEvent: string, isoTs: string, opts: EnvelopeOpts = {}): string {
  eventSeq += 1;
  const enrichments: Record<string, unknown> = {
    vcs: {
      type: "github",
      repo: opts.repo ?? "promptconduit/editor-extension",
      branch: opts.branch ?? "main",
      ...(opts.worktree ? { worktree: { is_worktree: true, path: "/worktrees/x" } } : {}),
    },
    trace: { trace_id: "ct".padEnd(32, "0"), span_id: "sp".padEnd(16, "0") },
    env: { os: "darwin", arch: "arm64" },
    ...(opts.enrichments ?? {}),
  };
  return JSON.stringify({
    schema: 2,
    event_id: `evt-${String(eventSeq).padStart(4, "0")}`,
    ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
    ...(opts.promptId ? { prompt_id: opts.promptId } : {}),
    tool,
    hook_event: hookEvent,
    captured_at: isoTs,
    cli_version: opts.cliVersion ?? "dev",
    raw_event: { ...(opts.sessionId ? { session_id: opts.sessionId } : {}), hook_event_name: hookEvent, ...(opts.raw ?? {}) },
    enrichments,
  });
}

// Raw events.jsonl lines (newest last, as appended).
export const sampleTelemetryLines: string[] = [
  v2Envelope("claude-code", "SessionStart", "2026-06-27T17:00:00Z", { sessionId: "cc-t", repo: "promptconduit/platform" }),
  v2Envelope("claude-code", "UserPromptSubmit", "2026-06-27T17:00:05Z", { sessionId: "cc-t", repo: "promptconduit/platform" }),
  v2Envelope("claude-code", "PreToolUse", "2026-06-27T17:00:07Z", { sessionId: "cc-t", repo: "promptconduit/platform" }),
  v2Envelope("claude-code", "PostToolUse", "2026-06-27T17:00:09Z", { sessionId: "cc-t", repo: "promptconduit/platform" }),
  v2Envelope("cursor", "afterAgentResponse", "2026-06-27T17:01:10Z", { sessionId: "cur-t", branch: "feat/local-dx" }),
  v2Envelope("claude-code", "Stop", "2026-06-27T17:01:30Z", { sessionId: "cc-t", repo: "promptconduit/platform" }),
];

export const sampleTelemetryJsonl = sampleTelemetryLines.join("\n") + "\n";

// ---------- stream panel (per-session envelopes) ----------
// Two Cursor agent tabs (conversation_id in raw_event) interleave with a Claude
// Code session; tab-B produces the newest event, so it is the auto-followed one.

export const sampleStreamLines: string[] = [
  v2Envelope("cursor", "beforeSubmitPrompt", "2026-06-30T17:00:00Z", { sessionId: "sess-A", raw: { conversation_id: "tab-A" } }),
  v2Envelope("cursor", "beforeShellExecution", "2026-06-30T17:00:04Z", { sessionId: "sess-A", raw: { conversation_id: "tab-A" } }),
  v2Envelope("claude-code", "UserPromptSubmit", "2026-06-30T17:00:10Z", { sessionId: "cc-1" }),
  v2Envelope("claude-code", "PreToolUse", "2026-06-30T17:00:12Z", { sessionId: "cc-1" }),
  v2Envelope("cursor", "beforeSubmitPrompt", "2026-06-30T17:01:00Z", { sessionId: "sess-B", raw: { conversation_id: "tab-B" } }),
  v2Envelope("cursor", "afterAgentResponse", "2026-06-30T17:01:20Z", { sessionId: "sess-B", raw: { conversation_id: "tab-B" } }),
];

export const sampleStreamJsonl = sampleStreamLines.join("\n") + "\n";

// ---------- cost enrichment envelopes ----------
// End-of-turn events carrying the `cost` slug, the way the CLI emits them since
// envelope v2 (Claude Code: on Stop, possibly several requests per turn;
// Cursor: one request per stop/afterAgentResponse).

export function costEnvelope(
  tool: string,
  isoTs: string,
  sessionId: string,
  requests: Array<Record<string, unknown>>,
  opts: EnvelopeOpts = {},
): string {
  const totalUSD = requests.reduce((s, r) => {
    const usd = (r.usd ?? {}) as Record<string, unknown>;
    return s + (typeof usd.total === "number" ? usd.total : 0);
  }, 0);
  return v2Envelope(tool, tool === "cursor" ? "stop" : "Stop", isoTs, {
    sessionId,
    ...opts,
    enrichments: {
      cost: { requests, totals: { usd: totalUSD, currency: "USD" } },
      ...(opts.enrichments ?? {}),
    },
  });
}

export function costRequest(p: Partial<Record<string, unknown>> & { request_id: string }): Record<string, unknown> {
  return {
    model: "claude-4.5-sonnet",
    model_priced: true,
    source: "exact",
    tokens: { input: 8000, output: 1200, cache_read: 24000, cache_write: 1500 },
    usd: { input: 0.024, output: 0.018, cache_read: 0.0072, cache_write: 0.0056, total: 0.0548, currency: "USD" },
    signals: {
      cache_hit_rate: 0.72,
      cache_miss_cost_share: 0.54,
      input_token_share: 0.24,
      tier: "standard",
      model_priced: true,
      tool_calls: 3,
    },
    ...p,
  };
}

// ---------- coaching (rich raw_event envelopes) ----------
// Realistic Claude Code hook payloads (shapes verified against real captured
// data) exercising every coaching signal: plan vs auto mode, slash commands, an
// MCP tool, a Skill invocation, two parallel subagents, a worktree, a hard
// interrupt, a compaction, and — the headline — two mid-task interruptions.

type NP = Record<string, unknown>;

function cEnv(
  hookEvent: string,
  isoTs: string,
  np: NP,
  opts: { session?: string; agentId?: string; agentType?: string; worktree?: boolean } = {},
): string {
  const session = opts.session ?? "cs1";
  const extra: NP = {};
  if (opts.agentId) {
    extra.agent_id = opts.agentId;
    extra.agent_type = opts.agentType ?? "";
  }
  return v2Envelope("claude-code", hookEvent, isoTs, {
    sessionId: session,
    repo: "promptconduit/promptconduit",
    branch: "feat/coaching",
    worktree: opts.worktree ?? false,
    raw: { ...extra, ...np },
    enrichments: { trace: { trace_id: ("ct-" + session).padEnd(32, "0"), span_id: "sp".padEnd(16, "0") } },
  });
}

function tc(name: string, resp: NP | null = {}, input: NP = {}): NP {
  return { tool_name: name, tool_use_id: name + "-id", tool_input: input, tool_response: resp };
}

export const sampleCoachingLines: string[] = [
  cEnv("SessionStart", "2026-06-28T17:00:00Z", {}, { worktree: true }),
  // Prompt 1: plan mode + slash command, then a clean Stop (not an interruption).
  cEnv("UserPromptSubmit", "2026-06-28T17:00:05Z", { permission_mode: "plan", prompt: "/code-review the diff" }, { worktree: true }),
  cEnv("PostToolBatch", "2026-06-28T17:00:07Z", { permission_mode: "plan", tool_calls: [tc("Read"), tc("Read")] }, { worktree: true }),
  cEnv("Stop", "2026-06-28T17:00:30Z", { permission_mode: "plan", stop_hook_active: false }, { worktree: true }),
  // Prompt 2: auto mode. A batch with an MCP tool, a Skill, and two PARALLEL subagents.
  cEnv("UserPromptSubmit", "2026-06-28T17:00:35Z", { permission_mode: "auto", prompt: "add tests for the parser" }, { worktree: true }),
  cEnv(
    "PostToolBatch",
    "2026-06-28T17:00:37Z",
    {
      permission_mode: "auto",
      tool_calls: [
        tc("Edit"),
        tc("Bash", { stdout: "ok", stderr: "", interrupted: false }),
        tc("mcp__stripe__create_customer", { type: "text" }),
        tc("Skill", { type: "text" }, { skill: "schedule", args: "nightly check" }),
        tc("Agent", { agentType: "Explore", totalDurationMs: 41000, totalTokens: 52000, status: "completed" }, { subagent_type: "Explore" }),
        tc("Agent", { agentType: "Explore", totalDurationMs: 38000, totalTokens: 47000, status: "completed" }, { subagent_type: "Explore" }),
      ],
    },
    { worktree: true },
  ),
  cEnv("PostToolUse", "2026-06-28T17:00:40Z", { permission_mode: "auto", duration_ms: 1500, tool_name: "Bash", tool_input: {}, tool_response: { stdout: "done", stderr: "", interrupted: false } }, { worktree: true }),
  // Prompt 3: arrives while the turn is still open → INTERRUPTION #1.
  cEnv("UserPromptSubmit", "2026-06-28T17:00:45Z", { permission_mode: "auto", prompt: "wait, also handle the empty case" }, { worktree: true }),
  cEnv("PostToolUseFailure", "2026-06-28T17:00:46Z", { permission_mode: "auto", is_interrupt: true, tool_name: "Bash", tool_response: null }, { worktree: true }),
  cEnv("SubagentStart", "2026-06-28T17:00:47Z", {}, { agentId: "a1", agentType: "Explore", worktree: true }),
  cEnv("SubagentStop", "2026-06-28T17:00:52Z", { stop_hook_active: false }, { agentId: "a1", agentType: "Explore", worktree: true }),
  cEnv("PreCompact", "2026-06-28T17:00:55Z", { permission_mode: "auto" }, { worktree: true }),
  // Prompt 4: still no Stop since prompt 3 → INTERRUPTION #2.
  cEnv("UserPromptSubmit", "2026-06-28T17:00:58Z", { permission_mode: "auto", prompt: "and update the changelog" }, { worktree: true }),
  cEnv("PostToolUse", "2026-06-28T17:00:59Z", { permission_mode: "auto", duration_ms: 300, tool_name: "Read", tool_input: {}, tool_response: { type: "text" } }, { worktree: true }),
  cEnv("Stop", "2026-06-28T17:01:10Z", { permission_mode: "auto", stop_hook_active: false }, { worktree: true }),
  // Prompt 5: another slash command, clean.
  cEnv("UserPromptSubmit", "2026-06-28T17:01:15Z", { permission_mode: "auto", prompt: "/ship it" }, { worktree: true }),
  cEnv("PostToolUse", "2026-06-28T17:01:16Z", { permission_mode: "auto", duration_ms: 800, tool_name: "WebFetch", tool_input: {}, tool_response: { type: "text" } }, { worktree: true }),
  cEnv("Stop", "2026-06-28T17:01:20Z", { permission_mode: "auto", stop_hook_active: false }, { worktree: true }),
];

export const sampleCoachingJsonl = sampleCoachingLines.join("\n") + "\n";
