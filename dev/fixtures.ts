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
