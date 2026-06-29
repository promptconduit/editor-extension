// Offline derivation: turn local event envelopes (~/.promptconduit/events.jsonl)
// into the shared coaching contract. Pure and dependency-free (no `vscode`, no
// fs) so it unit-tests cleanly and runs the same whether the lines came from a
// live tail or a one-shot full-history read.
//
// The envelope shape and the Claude Code hook payloads this reads were verified
// against real captured data:
//   - permission_mode lives at native_payload.permission_mode ("auto" | "plan" | …)
//   - parallel tool calls are batched: PostToolBatch.native_payload.tool_calls[]
//     each { tool_name, tool_input, tool_response, tool_use_id }; a lone call is
//     a PostToolUse with those fields at the top level (+ duration_ms)
//   - the Skill tool carries the invoked skill at tool_input.skill
//   - subagents spawn via the Agent/Task tool whose tool_response has
//     { agentType, totalDurationMs, totalTokens, status }; SubagentStart/Stop
//     carry agent_id/agent_type. Main-agent Stop has NO agent_id (the
//     disambiguator the interruption rule needs).

import {
  COACHING_SCHEMA_VERSION,
  CoachingMetrics,
  CoachingSnapshot,
  Counted,
  DailyCoachingPoint,
  SkillStat,
  SubagentTypeStat,
  TrendsResponse,
} from "./contract";

// ---- safe accessors (everything off the wire is `unknown`) ----

function asObj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asBool(v: unknown): boolean {
  return v === true;
}

// ---- normalized parsed event ----

export interface ToolCall {
  name: string;
  skill?: string; // the resolved SKILL.md name when name === "Skill"
  subagentType?: string; // for Agent/Task calls
  durationMs?: number; // for Agent/Task calls (tool_response.totalDurationMs)
  totalTokens?: number; // for Agent/Task calls
  success: boolean;
}

export interface ParsedEvent {
  sessionId: string;
  traceId: string;
  tool: string;
  hookEvent: string; // canonicalized (lowercase variants folded)
  capturedAt: string;
  capturedMs: number;
  permissionMode?: string;
  repo?: string;
  branch?: string;
  isWorktree: boolean;
  worktreePath?: string;
  agentId?: string; // set ⇒ this event belongs to a subagent, not the main agent
  agentType?: string;
  isInterrupt: boolean; // PostToolUseFailure hard interrupt
  prompt?: string;
  toolCalls: ToolCall[]; // PostToolUse (1) or PostToolBatch (N)
  batchSubagentCount: number; // Agent/Task calls in this single batch (parallelism)
}

const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
// Tool names that indicate worktree use (WorktreeCreate is a hook event, not a
// tool, and is handled separately by hookEvent).
const WORKTREE_TOOLS = new Set(["EnterWorktree", "ExitWorktree"]);

function canonHook(h: string): string {
  // Fold the occasional lowercase/camel variants seen in the wild.
  const map: Record<string, string> = {
    stop: "Stop",
    sessionstart: "SessionStart",
    sessionend: "SessionEnd",
    beforesubmitprompt: "UserPromptSubmit",
    userpromptexpansion: "UserPromptExpansion",
  };
  return map[h.toLowerCase()] ?? h;
}

function toolCallSuccess(resp: unknown, failed: boolean): boolean {
  if (failed) {
    return false;
  }
  const o = asObj(resp);
  if (!o) {
    return true; // no response object ⇒ treat a completed PostToolUse as success
  }
  if (o.is_error === true || o.isError === true || o.interrupted === true) {
    return false;
  }
  return true;
}

function extractToolCall(rawCall: Record<string, unknown>, failed: boolean): ToolCall {
  const name = asStr(rawCall.tool_name) ?? "";
  const input = asObj(rawCall.tool_input);
  const resp = rawCall.tool_response;
  const call: ToolCall = { name, success: toolCallSuccess(resp, failed) };
  if (name === "Skill") {
    call.skill = asStr(input?.skill) ?? asStr(input?.name) ?? asStr(input?.command);
  }
  if (SUBAGENT_TOOLS.has(name)) {
    const r = asObj(resp);
    call.subagentType = asStr(r?.agentType) ?? asStr(input?.subagent_type) ?? "agent";
    call.durationMs = asNum(r?.totalDurationMs);
    call.totalTokens = asNum(r?.totalTokens);
  }
  return call;
}

/** Parse one JSONL envelope line; returns null for blanks/garbage/non-objects. */
export function parseEnvelopeLine(line: string): ParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const env = asObj(obj);
  if (!env) {
    return null;
  }
  const np = asObj(env.native_payload) ?? {};
  const corr = asObj(env.correlation) ?? asObj(asObj(env.enrichment)?.correlation) ?? {};
  const git = asObj(asObj(env.enrichment)?.git) ?? asObj(env.git) ?? {};

  const hookEvent = canonHook(asStr(env.hook_event) ?? "");
  const capturedAt = asStr(env.captured_at) ?? "";
  const capturedMs = Date.parse(capturedAt);

  const toolCalls: ToolCall[] = [];
  let batchSubagentCount = 0;
  if (hookEvent === "PostToolUse") {
    if (asStr(np.tool_name)) {
      toolCalls.push(extractToolCall(np, false));
    }
  } else if (hookEvent === "PostToolUseFailure") {
    if (asStr(np.tool_name)) {
      toolCalls.push(extractToolCall(np, true));
    }
  } else if (hookEvent === "PostToolBatch") {
    for (const c of asArr(np.tool_calls)) {
      const co = asObj(c);
      if (co && asStr(co.tool_name)) {
        toolCalls.push(extractToolCall(co, false));
      }
    }
    batchSubagentCount = toolCalls.filter((t) => SUBAGENT_TOOLS.has(t.name)).length;
  }

  return {
    sessionId: asStr(np.session_id) ?? asStr(corr.trace_id) ?? "",
    traceId: asStr(corr.trace_id) ?? "",
    tool: asStr(env.tool) ?? "",
    hookEvent,
    capturedAt,
    capturedMs: Number.isFinite(capturedMs) ? capturedMs : 0,
    permissionMode: asStr(np.permission_mode),
    repo: asStr(git.repo_name),
    branch: asStr(git.branch),
    isWorktree: asBool(git.is_worktree),
    worktreePath: asStr(np.worktree_path) ?? asStr(git.worktree_path),
    agentId: asStr(np.agent_id),
    agentType: asStr(np.agent_type),
    isInterrupt: asBool(np.is_interrupt),
    prompt: asStr(np.prompt),
    toolCalls,
    batchSubagentCount,
  };
}

// ---- metric computation over one session's events ----

// mcp__<server>__<tool> — server is everything up to the next "__" (lazy), so
// servers that themselves contain single underscores are captured correctly.
const MCP_RE = /^mcp__(.+?)__/;

function mcpServer(name: string): string | undefined {
  const m = MCP_RE.exec(name);
  return m ? m[1] : undefined;
}

function isSlashCommand(prompt: string | undefined): boolean {
  return !!prompt && /^\/[a-zA-Z][\w-]*/.test(prompt.trim());
}

function rate(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

function topN<T extends { count: number }>(arr: T[], n: number): T[] {
  return [...arr].sort((a, b) => b.count - a.count).slice(0, n);
}

/** Compute the full metric set for an already-grouped, time-ordered session. */
export function computeMetrics(events: ParsedEvent[], sessionCount = 1): CoachingMetrics {
  const ordered = [...events].sort((a, b) => a.capturedMs - b.capturedMs);

  let prompts = 0;
  let slashPrompts = 0;
  let interruptions = 0;
  let contextCompactions = 0;
  // Turn-open and error-recovery state are PER SESSION: when trends merges many
  // sessions' events into one stream, interleaved sessions must not bleed into
  // each other (else an unrelated session's prompt looks like an interruption).
  const turnOpenBySession = new Map<string, boolean>();
  const recentlyFailedBySession = new Map<string, Set<string>>();

  const modeCounts = new Map<string, number>();
  const mcpCounts = new Map<string, number>();
  const skillAgg = new Map<string, { stat: SkillStat; ok: number; total: number }>();
  const worktreePaths = new Set<string>();
  let worktreeUsed = false;

  // tool-call accounting
  let toolInvocations = 0;
  let toolSuccesses = 0;
  let toolSteps = 0; // PostToolUse + PostToolBatch + PostToolUseFailure (one round-trip each)
  let mcpCalls = 0;
  let builtinCalls = 0;
  const toolNames = new Set<string>();

  // error recovery: failed call followed by a later same-tool success (per session).
  let failedCalls = 0;
  let recoveredCalls = 0;

  // subagents (from Agent/Task tool calls — they carry real durations)
  const subByType = new Map<string, { count: number; totalMs: number; withMs: number }>();
  let subCount = 0;
  let subTotalMs = 0;
  let subMaxConcurrent = 0;
  // fallback duration pairing via SubagentStart/Stop by agent_id
  const startById = new Map<string, number>();
  const pairedDurations: number[] = [];

  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const e of ordered) {
    if (e.permissionMode && e.hookEvent === "UserPromptSubmit") {
      bump(modeCounts, e.permissionMode);
    }

    switch (e.hookEvent) {
      case "UserPromptSubmit": {
        prompts++;
        if (turnOpenBySession.get(e.sessionId)) {
          interruptions++;
        }
        turnOpenBySession.set(e.sessionId, true);
        if (isSlashCommand(e.prompt)) {
          slashPrompts++;
        }
        break;
      }
      case "Stop": {
        // Only the MAIN agent's Stop closes a turn; a SubagentStop carries an
        // agent_id and must not be treated as the turn boundary.
        if (!e.agentId) {
          turnOpenBySession.set(e.sessionId, false);
        }
        break;
      }
      case "SessionStart":
        turnOpenBySession.set(e.sessionId, false);
        break;
      case "PreCompact":
        contextCompactions++;
        break;
      case "SubagentStart":
        if (e.agentId) {
          startById.set(e.agentId, e.capturedMs);
        }
        break;
      case "SubagentStop":
        if (e.agentId && startById.has(e.agentId)) {
          const ms = e.capturedMs - (startById.get(e.agentId) as number);
          if (ms > 0) {
            pairedDurations.push(ms);
          }
          startById.delete(e.agentId);
        }
        break;
      default:
        break;
    }

    if (e.isInterrupt) {
      // A hard Esc interrupt corroborates the turn-open rule for this session.
      turnOpenBySession.set(e.sessionId, true);
    }

    if (e.hookEvent === "PostToolUse" || e.hookEvent === "PostToolBatch" || e.hookEvent === "PostToolUseFailure") {
      // Each PostTool* event is one round-trip (one step). A failure is a single
      // failed call = one step too, so it must count or batching_score inflates.
      toolSteps++;
      if (e.batchSubagentCount > subMaxConcurrent) {
        subMaxConcurrent = e.batchSubagentCount;
      }
      let recentlyFailed = recentlyFailedBySession.get(e.sessionId);
      if (!recentlyFailed) {
        recentlyFailed = new Set<string>();
        recentlyFailedBySession.set(e.sessionId, recentlyFailed);
      }
      for (const call of e.toolCalls) {
        toolInvocations++;
        if (call.success) {
          toolSuccesses++;
        }
        if (call.name) {
          toolNames.add(call.name);
        }

        // error-recovery tracking (scoped to this session)
        if (!call.success) {
          failedCalls++;
          recentlyFailed.add(call.name);
        } else if (recentlyFailed.has(call.name)) {
          recoveredCalls++;
          recentlyFailed.delete(call.name);
        }

        const server = mcpServer(call.name);
        if (server) {
          mcpCalls++;
          bump(mcpCounts, server);
          recordSkill(skillAgg, `mcp:${server}`, server, "mcp_tool", call.success);
        } else if (call.name === "Skill") {
          const skill = call.skill ?? "skill";
          recordSkill(skillAgg, `skill:${skill}`, skill, "skill", call.success);
          builtinCalls++;
        } else if (SUBAGENT_TOOLS.has(call.name)) {
          subCount++;
          const t = call.subagentType ?? "agent";
          const agg = subByType.get(t) ?? { count: 0, totalMs: 0, withMs: 0 };
          agg.count++;
          if (call.durationMs && call.durationMs > 0) {
            agg.totalMs += call.durationMs;
            agg.withMs++;
            subTotalMs += call.durationMs;
          }
          subByType.set(t, agg);
          recordSkill(skillAgg, `subagent:${t}`, t, "subagent", call.success);
        } else {
          builtinCalls++;
        }

        if (WORKTREE_TOOLS.has(call.name)) {
          worktreeUsed = true;
        }
      }
    }

    if (e.isWorktree) {
      worktreeUsed = true;
    }
    if (e.worktreePath) {
      worktreeUsed = true;
      worktreePaths.add(e.worktreePath);
    }
    if (e.hookEvent === "WorktreeCreate") {
      worktreeUsed = true;
    }
  }

  const permission_modes = [...modeCounts.entries()]
    .map(([mode, prompt_count]) => ({ mode, prompt_count }))
    .sort((a, b) => b.prompt_count - a.prompt_count);
  const dominant_permission_mode = permission_modes[0]?.mode ?? "";
  const planPrompts = modeCounts.get("plan") ?? 0;

  const mcp_servers: Counted[] = [...mcpCounts.entries()].map(([name, count]) => ({ name, count }));

  const skills_used: SkillStat[] = [...skillAgg.values()].map(({ stat, ok, total }) => ({
    ...stat,
    success_rate: total > 0 ? ok / total : undefined,
  }));

  const by_type: SubagentTypeStat[] = [...subByType.entries()]
    .map(([type, v]) => ({ type, count: v.count, avg_duration_ms: v.withMs > 0 ? Math.round(v.totalMs / v.withMs) : 0 }))
    .sort((a, b) => b.count - a.count);
  // Average over the subagents we actually MEASURED (withMs), not the full count
  // — calls without a duration must not drag the average toward zero. Prefer
  // Agent/Task durations; fall back to Start/Stop pairing when none were present.
  const measuredCount = [...subByType.values()].reduce((s, v) => s + v.withMs, 0);
  let totalMs = subTotalMs;
  let durationN = measuredCount;
  if (measuredCount === 0 && pairedDurations.length > 0) {
    totalMs = pairedDurations.reduce((s, d) => s + d, 0);
    durationN = pairedDurations.length;
  }

  const metrics: CoachingMetrics = {
    prompts,
    interruptions: { count: interruptions, rate: rate(interruptions, prompts) },
    permission_modes,
    dominant_permission_mode,
    plan_mode_adoption_rate: rate(planPrompts, prompts),
    mcp_servers: topN(mcp_servers, 12),
    mcp_server_count: mcp_servers.length,
    skills_used: topN(skills_used, 20),
    slash_command_adoption_rate: rate(slashPrompts, prompts),
    skill_md_count: skills_used.filter((s) => s.type === "skill").reduce((sum, s) => sum + s.count, 0),
    worktree: { used: worktreeUsed, paths: [...worktreePaths] },
    subagents: {
      count: subCount,
      total_duration_ms: totalMs,
      avg_duration_ms: durationN > 0 ? Math.round(totalMs / durationN) : 0,
      max_concurrent: Math.max(subMaxConcurrent, subCount > 0 ? 1 : 0),
      by_type,
    },
    tool_invocations: toolInvocations,
    tool_success_rate: rate(toolSuccesses, toolInvocations),
    tool_diversity: toolNames.size,
    context_compactions: contextCompactions,
    avg_prompts_per_session: sessionCount > 0 ? prompts / sessionCount : prompts,
    batching_score: rate(toolInvocations, toolSteps),
    mcp_vs_builtin_ratio: rate(mcpCalls, builtinCalls),
    error_recovery_rate: rate(recoveredCalls, failedCalls),
  };
  return metrics;
}

function recordSkill(
  agg: Map<string, { stat: SkillStat; ok: number; total: number }>,
  identifier: string,
  name: string,
  type: SkillStat["type"],
  success: boolean,
): void {
  const cur = agg.get(identifier) ?? { stat: { identifier, name, type, count: 0 }, ok: 0, total: 0 };
  cur.stat.count++;
  cur.total++;
  if (success) {
    cur.ok++;
  }
  agg.set(identifier, cur);
}

// ---- grouping / public entry points ----

export function groupBySession(events: ParsedEvent[]): Map<string, ParsedEvent[]> {
  const m = new Map<string, ParsedEvent[]>();
  for (const e of events) {
    if (!e.sessionId) {
      continue;
    }
    const arr = m.get(e.sessionId) ?? [];
    arr.push(e);
    m.set(e.sessionId, arr);
  }
  return m;
}

/**
 * Build the live snapshot for the most-recently-active session (the one whose
 * latest event is newest), mirroring the cost panel's "follow the active agent
 * tab" behaviour. Returns undefined when there are no usable events.
 */
export function reduceToSnapshot(events: ParsedEvent[]): CoachingSnapshot | undefined {
  const sessions = groupBySession(events);
  let best: { id: string; evs: ParsedEvent[]; last: number } | undefined;
  for (const [id, evs] of sessions) {
    const last = evs.reduce((m, e) => Math.max(m, e.capturedMs), 0);
    if (!best || last > best.last) {
      best = { id, evs, last };
    }
  }
  if (!best) {
    return undefined;
  }
  const evs = best.evs;
  const tool = evs.find((e) => e.tool)?.tool ?? "";
  const repo = evs.find((e) => e.repo)?.repo;
  const branch = evs.find((e) => e.branch)?.branch;
  const startedMs = evs.reduce((m, e) => Math.min(m, e.capturedMs || Infinity), Infinity);
  const metrics = computeMetrics(evs, 1);
  return {
    schema_version: COACHING_SCHEMA_VERSION,
    scope: "session",
    session_id: best.id,
    tool,
    repo,
    branch,
    started_at: Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : "",
    updated_at: new Date(best.last).toISOString(),
    metrics,
    insights: [], // attached by the controller via coaching/insights.ts
  };
}

/**
 * Aggregate ALL sessions in the buffer into a trends report. `windowDays` keeps
 * only events captured within the window (0 = all). Designed for the local
 * full-history read so the tab shows real trends offline.
 */
export function reduceToTrends(events: ParsedEvent[], windowDays = 0, nowMs = 0): TrendsResponse {
  const now = nowMs || maxCaptured(events);
  const cutoff = windowDays > 0 ? now - windowDays * 86_400_000 : 0;
  const inWindow = events.filter((e) => e.capturedMs >= cutoff);
  const sessions = groupBySession(inWindow);
  const metrics = computeMetrics(inWindow, sessions.size || 1);

  const daily = buildDaily(inWindow);
  const startMs = inWindow.reduce((m, e) => Math.min(m, e.capturedMs || Infinity), Infinity);
  return {
    schema_version: COACHING_SCHEMA_VERSION,
    scope: "trends",
    period: {
      start: Number.isFinite(startMs) ? new Date(startMs).toISOString() : "",
      end: now ? new Date(now).toISOString() : "",
      days: windowDays,
    },
    metrics,
    previous: {},
    daily,
    insights: [],
  };
}

function maxCaptured(events: ParsedEvent[]): number {
  return events.reduce((m, e) => Math.max(m, e.capturedMs), 0);
}

function buildDaily(events: ParsedEvent[]): DailyCoachingPoint[] {
  const byDay = new Map<string, ParsedEvent[]>();
  for (const e of events) {
    if (!e.capturedMs) {
      continue;
    }
    const day = new Date(e.capturedMs).toISOString().slice(0, 10);
    const arr = byDay.get(day) ?? [];
    arr.push(e);
    byDay.set(day, arr);
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, evs]) => {
      const m = computeMetrics(evs, groupBySession(evs).size || 1);
      return {
        date,
        prompts: m.prompts,
        interruptions: m.interruptions.count,
        subagents: m.subagents.count,
        plan_mode_adoption_rate: m.plan_mode_adoption_rate,
      };
    });
}
