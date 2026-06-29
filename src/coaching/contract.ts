// The shared "agent coaching" metrics contract.
//
// This is the single source of truth for the shape of the coaching report. The
// SAME object is produced two ways and rendered by one renderer:
//   1. locally, by deriving from ~/.promptconduit/events.jsonl (offline-first —
//      the whole report works with no network: see coaching/derive.ts), and
//   2. by the platform's GET /v1/me/trends endpoint (additive: cross-machine
//      history and longer retention, merged in only when authed/online).
//
// Keep this file in lockstep with the server-side coaching contract. It is
// pure data + types — no `vscode`, no HTML — so it unit-tests cleanly and both
// the derivation and the renderer import it.

export const COACHING_SCHEMA_VERSION = 1;

/** A counted dimension value, e.g. one MCP server or one permission mode. */
export interface Counted {
  name: string;
  count: number;
}

/** Permission / interaction mode the agent ran under for a set of prompts. */
export interface PermissionModeStat {
  mode: string; // "auto" | "plan" | "acceptEdits" | "default" | "bypassPermissions" | ...
  prompt_count: number;
}

export type SkillType = "slash_command" | "skill" | "subagent" | "mcp_tool";

/** One thing the engineer invoked, aggregated across a session or a period. */
export interface SkillStat {
  identifier: string; // stable key, e.g. "skill:code-review", "mcp:stripe", "subagent:Explore"
  name: string; // human label
  type: SkillType;
  count: number;
  success_rate?: number; // [0,1] when the invocation reports success/failure
}

/** Per-subagent-type rollup. */
export interface SubagentTypeStat {
  type: string; // "Explore", "general-purpose", "Plan", ... ("agent" when untyped)
  count: number;
  avg_duration_ms: number;
}

export interface SubagentStats {
  count: number;
  total_duration_ms: number;
  avg_duration_ms: number;
  max_concurrent: number; // most subagents spawned in a single parallel batch
  by_type: SubagentTypeStat[];
}

export interface WorktreeStats {
  used: boolean;
  paths: string[];
}

export interface TokenStats {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total: number;
}

/**
 * The full coaching metric set. Field names are identical in the local and the
 * server payloads so the renderer never branches on source. Token/cost fields
 * are optional: they ride the local cost feed (also offline) when present and
 * are simply omitted otherwise — every other metric derives from events.jsonl.
 */
export interface CoachingMetrics {
  prompts: number;
  interruptions: { count: number; rate: number };

  permission_modes: PermissionModeStat[];
  dominant_permission_mode: string;
  plan_mode_adoption_rate: number; // [0,1] prompts run in plan mode

  mcp_servers: Counted[];
  mcp_server_count: number;

  skills_used: SkillStat[];
  slash_command_adoption_rate: number; // [0,1] prompts that were a /slash-command
  skill_md_count: number; // SKILL.md invocations via the Skill tool

  worktree: WorktreeStats;
  subagents: SubagentStats;

  tool_invocations: number;
  tool_success_rate: number; // [0,1]
  tool_diversity: number; // distinct tool names

  // Recommended extra coaching signals.
  context_compactions: number; // PreCompact count — frequent = oversized context
  avg_prompts_per_session: number;
  batching_score: number; // avg tool calls per tool step — higher = fewer round-trips
  mcp_vs_builtin_ratio: number; // mcp tool calls / builtin tool calls
  error_recovery_rate: number; // [0,1] failed tool calls followed by a same-tool success

  // Optional, from the local cost feed (still offline) when available.
  tokens?: TokenStats;
  cache_hit_rate?: number; // [0,1]
  cost_usd?: number;
}

export type InsightSeverity = "info" | "tip" | "warn";

/** One piece of coaching feedback, linked to a curated article by slug. */
export interface Insight {
  type: string; // canonical insight type — see INSIGHT_SLUGS
  severity: InsightSeverity;
  title: string;
  detail: string;
  metric_value?: string;
  article_slug: string;
  article_url: string; // absolute https URL for "read the full article"
}

/** Live, single-session report (what the extension tab shows by default). */
export interface CoachingSnapshot {
  schema_version: number;
  scope: "session";
  session_id: string;
  tool: string;
  repo?: string;
  branch?: string;
  started_at: string;
  updated_at: string;
  metrics: CoachingMetrics;
  insights: Insight[];
}

export interface DailyCoachingPoint {
  date: string; // YYYY-MM-DD
  prompts: number;
  interruptions: number;
  subagents: number;
  plan_mode_adoption_rate: number;
}

/** Historical report over a period (web dashboard + the tab's "all time" view). */
export interface TrendsResponse {
  schema_version: number;
  scope: "trends";
  period: { start: string; end: string; days: number };
  metrics: CoachingMetrics;
  previous: Partial<CoachingMetrics>;
  daily: DailyCoachingPoint[];
  insights: Insight[];
}

// The canonical insight-type → article-slug map. This MUST stay in sync with the
// coaching article frontmatter and the server-side insight builder. The slug is
// the contract the renderer resolves (extension → bundled article + online
// link; web → /coaching/<slug>).
export const INSIGHT_SLUGS: Record<string, string> = {
  high_interruption_rate: "reduce-interruptions",
  low_plan_mode_adoption: "use-plan-mode",
  subagent_underuse: "delegate-with-subagents",
  worktree_opportunity: "isolate-with-worktrees",
  low_slash_command_adoption: "adopt-skills-and-slash-commands",
  mcp_imbalance: "right-size-mcp-servers",
  low_cache_hit: "improve-cache-hit-rate",
  low_tool_success: "raise-tool-success-rate",
  high_tool_volume: "batch-tool-calls",
};

export const COACHING_SITE_BASE = "https://promptconduit.dev/coaching";

/** Resolve an insight type to its absolute article URL. */
export function articleUrlFor(type: string): string {
  const slug = INSIGHT_SLUGS[type] ?? "";
  return slug ? `${COACHING_SITE_BASE}/${slug}` : COACHING_SITE_BASE;
}
