// Shared sample data for unit tests, the webview preview, and `npm run dev`
// seeding. Realistic enough to exercise the cost logic (tips/signals/state) and
// the telemetry feed without running the CLI or a real AI session.

import { CostEvent, CostRecord, SessionSummary } from "../src/types";

// ---------- cost feed (CostEvent / SessionSummary) ----------

function ev(p: Partial<CostEvent> & Pick<CostEvent, "session_id" | "request_id" | "ts">): CostEvent {
  return {
    v: 2,
    kind: "cost_event",
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
  v: 2,
  kind: "session_summary",
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
  v: 2,
  kind: "session_summary",
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

export const sampleRecords: CostRecord[] = [...sampleEvents, heavySummary, cleanSummary];

// ---------- telemetry feed (events.jsonl envelopes) ----------

function envelope(tool: string, hookEvent: string, isoTs: string, repo: string, branch = "main") {
  return JSON.stringify({
    envelope_version: "1.2",
    cli_version: "dev",
    tool,
    hook_event: hookEvent,
    captured_at: isoTs,
    native_payload: {},
    enrichment: { git: { repo_name: repo, branch } },
  });
}

// Raw events.jsonl lines (newest last, as appended), for the Telemetry panel.
export const sampleTelemetryLines: string[] = [
  envelope("claude-code", "SessionStart", "2026-06-27T17:00:00Z", "promptconduit"),
  envelope("claude-code", "UserPromptSubmit", "2026-06-27T17:00:05Z", "promptconduit"),
  envelope("claude-code", "PreToolUse", "2026-06-27T17:00:07Z", "promptconduit"),
  envelope("claude-code", "PostToolUse", "2026-06-27T17:00:09Z", "promptconduit"),
  envelope("cursor", "afterAgentResponse", "2026-06-27T17:01:10Z", "editor-extension", "feat/local-dx"),
  envelope("claude-code", "Stop", "2026-06-27T17:01:30Z", "promptconduit"),
];

export const sampleTelemetryJsonl = sampleTelemetryLines.join("\n") + "\n";

// ---------- stream panel (per-session envelopes) ----------
// Like the telemetry lines, but each envelope carries a session key in
// native_payload so the Stream panel can group + follow per session. Two Cursor
// agent tabs (conversation_id) interleave with a Claude Code session (session_id);
// tab-B produces the newest event, so it is the auto-followed session.

function streamEnvelope(
  tool: string,
  hookEvent: string,
  isoTs: string,
  np: Record<string, unknown>,
  repo = "editor-extension",
  branch = "feat/live-stream-panel",
): string {
  return JSON.stringify({
    envelope_version: "1.2",
    cli_version: "dev",
    tool,
    hook_event: hookEvent,
    captured_at: isoTs,
    native_payload: np,
    enrichment: { git: { repo_name: repo, branch } },
  });
}

export const sampleStreamLines: string[] = [
  streamEnvelope("cursor", "beforeSubmitPrompt", "2026-06-30T17:00:00Z", { conversation_id: "tab-A", session_id: "sess-A" }),
  streamEnvelope("cursor", "beforeShellExecution", "2026-06-30T17:00:04Z", { conversation_id: "tab-A", session_id: "sess-A" }),
  streamEnvelope("claude-code", "UserPromptSubmit", "2026-06-30T17:00:10Z", { session_id: "cc-1" }),
  streamEnvelope("claude-code", "PreToolUse", "2026-06-30T17:00:12Z", { session_id: "cc-1" }),
  streamEnvelope("cursor", "beforeSubmitPrompt", "2026-06-30T17:01:00Z", { conversation_id: "tab-B", session_id: "sess-B" }),
  streamEnvelope("cursor", "afterAgentResponse", "2026-06-30T17:01:20Z", { conversation_id: "tab-B", session_id: "sess-B" }),
];

export const sampleStreamJsonl = sampleStreamLines.join("\n") + "\n";

// ---------- coaching (rich native_payload envelopes) ----------
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
  return JSON.stringify({
    envelope_version: "1.2",
    cli_version: "dev",
    tool: "claude-code",
    hook_event: hookEvent,
    captured_at: isoTs,
    correlation: { trace_id: "ct-" + session, span_id: "sp" },
    enrichment: { git: { repo_name: "promptconduit", branch: "feat/coaching", is_worktree: opts.worktree ?? false } },
    native_payload: { session_id: session, hook_event_name: hookEvent, ...extra, ...np },
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
