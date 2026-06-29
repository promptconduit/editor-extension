// Turn coaching metrics into actionable insights. Pure (no `vscode`, no HTML) so
// it unit-tests cleanly and is shared by the live tab and the trends view. Each
// insight is conditional on a conservative threshold — we surface feedback only
// when it would genuinely help, mirroring the cost panel's tips engine — and
// links to a curated article by slug (resolved from contract.ts).
//
// This mirrors the server-side insight builder so both the offline tab and the
// signed-in dashboard produce the same feedback from the same metrics.

import { CoachingMetrics, INSIGHT_SLUGS, Insight, articleUrlFor } from "./contract";

function mk(
  type: string,
  severity: Insight["severity"],
  title: string,
  detail: string,
  metricValue?: string,
): Insight {
  return {
    type,
    severity,
    title,
    detail,
    metric_value: metricValue,
    article_slug: INSIGHT_SLUGS[type] ?? type,
    article_url: articleUrlFor(type),
  };
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/**
 * Build the ordered insight list for a metric set. `minPrompts` guards against
 * firing on a session too small to be meaningful. Returns [] when nothing is
 * actionable.
 */
export function buildCoachingInsights(m: CoachingMetrics, minPrompts = 3): Insight[] {
  const insights: Insight[] = [];
  if (m.prompts < minPrompts) {
    return insights;
  }

  // Interruptions — the signal the user specifically asked to surface.
  if (m.interruptions.rate >= 0.3 && m.interruptions.count >= 2) {
    insights.push(
      mk(
        "high_interruption_rate",
        "warn",
        "You interrupt the agent often",
        `${m.interruptions.count} of ${m.prompts} prompts (${pct(m.interruptions.rate)}) landed while the agent was still working. Front-load context and use plan mode so it can finish a thought.`,
        pct(m.interruptions.rate),
      ),
    );
  }

  // Plan-mode adoption.
  if (m.plan_mode_adoption_rate < 0.15 && m.prompts >= 5) {
    insights.push(
      mk(
        "low_plan_mode_adoption",
        "tip",
        "Try plan mode for non-trivial work",
        `Only ${pct(m.plan_mode_adoption_rate)} of prompts ran in plan mode. Planning before editing catches wrong approaches before they cost tokens.`,
        pct(m.plan_mode_adoption_rate),
      ),
    );
  }

  // Subagent under-use, weighted by how tool-heavy the work is.
  if (m.subagents.count === 0 && m.tool_invocations >= 40) {
    insights.push(
      mk(
        "subagent_underuse",
        "tip",
        "Delegate with subagents",
        `${m.tool_invocations} tool calls and no subagents. Parallel agents cover broad searches and audits faster and keep your main context clean.`,
        `${m.subagents.count}`,
      ),
    );
  }

  // Worktree opportunity for heavy, non-isolated sessions.
  if (!m.worktree.used && m.tool_invocations >= 80) {
    insights.push(
      mk(
        "worktree_opportunity",
        "info",
        "Consider a worktree for heavy work",
        "This was a large, multi-file session run in your main checkout. A git worktree lets the agent experiment safely on its own branch.",
      ),
    );
  }

  // Slash-command / skill adoption.
  if (m.slash_command_adoption_rate < 0.1 && m.skill_md_count === 0 && m.prompts >= 8) {
    insights.push(
      mk(
        "low_slash_command_adoption",
        "tip",
        "Capture repeatable work as skills",
        "You rarely use slash-commands or skills. Packaging recurring workflows gives you consistent, tested prompts with less typing.",
      ),
    );
  }

  // Tool success rate.
  if (m.tool_success_rate > 0 && m.tool_success_rate < 0.85 && m.tool_invocations >= 20) {
    insights.push(
      mk(
        "low_tool_success",
        "warn",
        "Some tool calls are failing",
        `${pct(m.tool_success_rate)} tool success rate. Failed calls each cost a round-trip — give the agent the paths and context to get them right first time.`,
        pct(m.tool_success_rate),
      ),
    );
  }

  // High tool volume / low batching.
  if (m.batching_score > 0 && m.batching_score < 1.4 && m.tool_invocations >= 60) {
    insights.push(
      mk(
        "high_tool_volume",
        "info",
        "Batch related tool calls",
        `${m.tool_invocations} tool calls at ${m.batching_score.toFixed(1)} per step. Running independent reads/edits together cuts round-trips and output tokens.`,
        m.tool_invocations.toString(),
      ),
    );
  }

  // Cache hit rate (only when the local cost feed supplied it).
  if (typeof m.cache_hit_rate === "number" && m.cache_hit_rate < 0.4) {
    insights.push(
      mk(
        "low_cache_hit",
        "tip",
        "Improve your cache hit rate",
        `${pct(m.cache_hit_rate)} of input was a cache hit. Reuse context across turns instead of re-pasting files — cached reads are ~10× cheaper.`,
        pct(m.cache_hit_rate),
      ),
    );
  }

  return insights;
}
