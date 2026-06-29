import { describe, it, expect } from "vitest";
import {
  parseEnvelopeLine,
  computeMetrics,
  reduceToSnapshot,
  reduceToTrends,
} from "../../src/coaching/derive";
import { buildCoachingInsights } from "../../src/coaching/insights";
import { renderCoachingHtml } from "../../src/coaching/render";
import { articleUrlFor } from "../../src/coaching/contract";
import { sampleCoachingLines } from "../../dev/fixtures";

const events = sampleCoachingLines
  .map(parseEnvelopeLine)
  .filter((e): e is NonNullable<typeof e> => e !== null);

describe("parseEnvelopeLine", () => {
  it("extracts permission_mode, prompt, and worktree from a UserPromptSubmit", () => {
    const e = parseEnvelopeLine(sampleCoachingLines[1])!;
    expect(e.hookEvent).toBe("UserPromptSubmit");
    expect(e.permissionMode).toBe("plan");
    expect(e.prompt).toContain("/code-review");
    expect(e.isWorktree).toBe(true);
    expect(e.sessionId).toBe("cs1");
  });

  it("expands PostToolBatch into individual tool calls incl. MCP, Skill, and parallel Agents", () => {
    const batch = events.find((e) => e.hookEvent === "PostToolBatch" && e.toolCalls.length > 2)!;
    const names = batch.toolCalls.map((t) => t.name);
    expect(names).toContain("mcp__stripe__create_customer");
    expect(names).toContain("Skill");
    expect(batch.toolCalls.find((t) => t.name === "Skill")!.skill).toBe("schedule");
    expect(batch.batchSubagentCount).toBe(2); // two parallel Agent calls
    const agent = batch.toolCalls.find((t) => t.name === "Agent")!;
    expect(agent.subagentType).toBe("Explore");
    expect(agent.durationMs).toBeGreaterThan(0);
  });

  it("flags a hard interrupt on PostToolUseFailure", () => {
    const fail = events.find((e) => e.hookEvent === "PostToolUseFailure")!;
    expect(fail.isInterrupt).toBe(true);
    expect(fail.toolCalls[0].success).toBe(false);
  });

  it("returns null for blank / malformed / non-object lines", () => {
    expect(parseEnvelopeLine("")).toBeNull();
    expect(parseEnvelopeLine("{nope")).toBeNull();
    expect(parseEnvelopeLine("42")).toBeNull();
  });
});

describe("computeMetrics", () => {
  const m = computeMetrics(events, 1);

  it("counts prompts and detects mid-task interruptions (turn-open rule)", () => {
    expect(m.prompts).toBe(5);
    // Prompts 3 and 4 arrive before a main Stop closes the turn → 2 interruptions.
    // Prompts 1, 2, 5 each follow a Stop (or start) → not interruptions.
    expect(m.interruptions.count).toBe(2);
    expect(m.interruptions.rate).toBeCloseTo(0.4, 5);
  });

  it("does NOT treat a SubagentStop as a turn-closing main Stop", () => {
    // The SubagentStop between prompts 3 and 4 must not reset the open turn,
    // otherwise prompt 4 would be miscounted as non-interrupting.
    const stops = events.filter((e) => e.hookEvent === "Stop");
    expect(stops.every((s) => !s.agentId)).toBe(true);
    expect(m.interruptions.count).toBe(2);
  });

  it("computes permission-mode distribution and plan adoption", () => {
    expect(m.dominant_permission_mode).toBe("auto"); // 4 auto prompts vs 1 plan
    expect(m.plan_mode_adoption_rate).toBeCloseTo(0.2, 5); // 1/5
    const modes = m.permission_modes.map((p) => p.mode);
    expect(modes).toEqual(expect.arrayContaining(["auto", "plan"]));
  });

  it("detects MCP servers, skills, and slash-command adoption", () => {
    expect(m.mcp_servers.map((s) => s.name)).toContain("stripe");
    expect(m.mcp_server_count).toBe(1);
    expect(m.skill_md_count).toBe(1); // the Skill(schedule) call
    expect(m.skills_used.some((s) => s.type === "skill" && s.name === "schedule")).toBe(true);
    expect(m.slash_command_adoption_rate).toBeCloseTo(0.4, 5); // /code-review + /ship of 5
  });

  it("aggregates subagents with durations and parallelism", () => {
    expect(m.subagents.count).toBe(2); // two Agent calls
    expect(m.subagents.by_type[0].type).toBe("Explore");
    expect(m.subagents.avg_duration_ms).toBeGreaterThan(0);
    expect(m.subagents.max_concurrent).toBe(2);
  });

  it("marks worktree usage and counts compactions", () => {
    expect(m.worktree.used).toBe(true);
    expect(m.context_compactions).toBe(1);
  });

  it("computes tool success rate excluding the failed/interrupted call", () => {
    // Many successful tool calls + exactly one PostToolUseFailure.
    expect(m.tool_success_rate).toBeGreaterThan(0.8);
    expect(m.tool_success_rate).toBeLessThan(1);
    expect(m.tool_diversity).toBeGreaterThanOrEqual(5);
  });
});

describe("buildCoachingInsights", () => {
  const m = computeMetrics(events, 1);
  const insights = buildCoachingInsights(m);

  it("surfaces the high-interruption insight with an article link", () => {
    const interrupt = insights.find((i) => i.type === "high_interruption_rate");
    expect(interrupt).toBeDefined();
    expect(interrupt!.severity).toBe("warn");
    expect(interrupt!.article_url).toBe(articleUrlFor("high_interruption_rate"));
    expect(interrupt!.article_slug).toBe("reduce-interruptions");
  });

  it("returns nothing for a too-small session", () => {
    const tiny = computeMetrics(events.slice(0, 2), 1);
    expect(buildCoachingInsights(tiny)).toEqual([]);
  });
});

describe("reduceToSnapshot / reduceToTrends", () => {
  it("builds a snapshot for the active session", () => {
    const snap = reduceToSnapshot(events)!;
    expect(snap.scope).toBe("session");
    expect(snap.session_id).toBe("cs1");
    expect(snap.tool).toBe("claude-code");
    expect(snap.metrics.prompts).toBe(5);
  });

  it("builds a trends report with daily points", () => {
    const trends = reduceToTrends(events, 0);
    expect(trends.scope).toBe("trends");
    expect(trends.daily.length).toBeGreaterThanOrEqual(1);
    expect(trends.metrics.prompts).toBe(5);
  });
});

describe("renderCoachingHtml", () => {
  it("renders the report with the key sections and the interruption insight", () => {
    const snap = reduceToSnapshot(events)!;
    snap.insights = buildCoachingInsights(snap.metrics);
    const html = renderCoachingHtml(snap, reduceToTrends(events, 0));
    expect(html).toContain("Agent coaching");
    expect(html).toContain("MCP servers used");
    expect(html).toContain("stripe");
    expect(html).toContain("Skills &amp; subagents");
    expect(html).toContain("Explore");
    expect(html).toContain("interrupt"); // the interruption insight copy
    expect(html).toContain("https://promptconduit.dev/coaching/reduce-interruptions");
  });

  it("renders a zero-state when there are no events", () => {
    const html = renderCoachingHtml(undefined);
    expect(html).toContain("No sessions yet");
  });

  it("escapes content (no script injection via tool names)", () => {
    expect(renderCoachingHtml(undefined)).not.toContain("<script");
  });

  it("renders a 'log disabled' state distinct from the empty state", () => {
    const html = renderCoachingHtml(undefined, undefined, { disabled: true });
    expect(html).toContain("Local log disabled");
    expect(html).toContain("PROMPTCONDUIT_EVENT_LOG=0");
  });

  it("falls back to trends when the active session has 0 prompts (does not hide history)", () => {
    // Active (newest) session emitted only a SessionStart → 0 prompts, but an
    // older session has real activity. The report must still render.
    const snap = reduceToSnapshot(events)!;
    const empty = { ...snap, metrics: { ...snap.metrics, prompts: 0 } };
    const trends = reduceToTrends(events, 0);
    const html = renderCoachingHtml(empty, trends);
    expect(html).not.toContain("No sessions yet");
    expect(html).toContain("all local history");
  });
});

describe("per-session state machines", () => {
  // Two sessions whose prompts interleave in time. Neither interrupts within its
  // own session; the OLD global state machine would miscount B's prompt as an
  // interruption of A's open turn.
  function env(session: string, hook: string, ts: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      tool: "claude-code",
      hook_event: hook,
      captured_at: ts,
      correlation: { trace_id: "t-" + session },
      native_payload: { session_id: session, hook_event_name: hook, ...extra },
    });
  }
  const interleaved = [
    env("A", "UserPromptSubmit", "2026-06-28T10:00:00Z", { permission_mode: "auto", prompt: "a1" }),
    env("B", "UserPromptSubmit", "2026-06-28T10:00:01Z", { permission_mode: "auto", prompt: "b1" }),
    env("A", "Stop", "2026-06-28T10:00:04Z"),
    env("B", "Stop", "2026-06-28T10:00:05Z"),
  ].map(parseEnvelopeLine).filter((e): e is NonNullable<typeof e> => e !== null);

  it("does not count cross-session interleaving as interruptions", () => {
    const m = computeMetrics(interleaved, 2);
    expect(m.prompts).toBe(2);
    expect(m.interruptions.count).toBe(0);
  });
});
