// Pure renderer for the Coaching tab. Data in, HTML out — no `vscode`, no fs —
// so the webview preview and unit tests render it without a live editor. The
// webview runs with enableScripts:false; all interactivity is native
// <details>/<a>. Mirrors the cost panel's renderBreakdownHtml structure and
// theme so the two surfaces feel like one product.

import { escapeHtml } from "../html";
import { isSafeHttpUrl } from "../links";
import {
  CoachingMetrics,
  CoachingSnapshot,
  Counted,
  Insight,
  SkillStat,
  TrendsResponse,
} from "./contract";
import { articleFor } from "./articles";

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
function num(n: number): string {
  return Math.round(n).toLocaleString();
}
function dur(ms: number): string {
  if (ms <= 0) {
    return "—";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const s = ms / 1000;
  if (s < 90) {
    return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  }
  return `${Math.round(s / 60)}m`;
}
function toolLabel(tool: string): string {
  switch (tool) {
    case "claude-code":
      return "Claude Code";
    case "cursor":
      return "Cursor";
    default:
      return tool || "your assistant";
  }
}
function modeLabel(mode: string): string {
  switch (mode) {
    case "auto":
      return "Auto";
    case "plan":
      return "Plan";
    case "acceptEdits":
      return "Accept edits";
    case "bypassPermissions":
      return "Bypass";
    case "default":
      return "Default (ask)";
    default:
      return mode || "—";
  }
}

// ---- sections ----

function heroHtml(snap: CoachingSnapshot): string {
  const m = snap.metrics;
  const where = snap.repo ? `${snap.repo}${snap.branch ? ` · ${snap.branch}` : ""}` : "this session";
  return `
    <header class="hero">
      <div class="hero-badges">
        <span class="badge">${escapeHtml(toolLabel(snap.tool))}</span>
        <span class="badge subtle">${escapeHtml(modeLabel(snap.metrics.dominant_permission_mode))} mode</span>
      </div>
      <p class="hero-eyebrow">Agent coaching</p>
      <div class="hero-amount">${num(m.prompts)} <span class="hero-unit">prompts</span></div>
      <p class="hero-sub">${escapeHtml(where)} · ${num(m.tool_invocations)} tool calls · ${pct(m.tool_success_rate)} succeeded</p>
    </header>`;
}

function insightLi(ins: Insight): string {
  const art = articleFor(ins.type);
  const link = isSafeHttpUrl(ins.article_url)
    ? ` <a href="${escapeHtml(ins.article_url)}">Read more →</a>`
    : "";
  const body = art
    ? `<details class="coach-more"><summary>How to improve</summary>${art.body
        .map((p) => `<p>${escapeHtml(p)}</p>`)
        .join("")}<p class="muted">${link}</p></details>`
    : `<span>${link}</span>`;
  const val = ins.metric_value ? `<span class="coach-val">${escapeHtml(ins.metric_value)}</span>` : "";
  return `
    <li class="coach ${ins.severity}">
      <div class="coach-head"><strong>${escapeHtml(ins.title)}</strong>${val}</div>
      <span class="coach-detail">${escapeHtml(ins.detail)}</span>
      ${body}
    </li>`;
}

function insightsHtml(insights: Insight[]): string {
  if (insights.length === 0) {
    return `<section><h2>Coaching</h2><p class="muted">No coaching flags this session — nice work. Keep front-loading context and planning non-trivial work.</p></section>`;
  }
  return `<section><h2>Coaching</h2><ul class="coaches">${insights.map(insightLi).join("")}</ul></section>`;
}

function metricCell(label: string, value: string, state: "good" | "ok" | "warn", hint: string): string {
  return `
    <div class="metric ${state}">
      <div class="metric-value">${escapeHtml(value)}</div>
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-hint muted">${escapeHtml(hint)}</div>
    </div>`;
}

function driversHtml(m: CoachingMetrics): string {
  const cells = [
    metricCell(
      "Plan-mode use",
      pct(m.plan_mode_adoption_rate),
      m.plan_mode_adoption_rate >= 0.3 ? "good" : m.plan_mode_adoption_rate < 0.1 ? "warn" : "ok",
      "Share of prompts run in plan mode.",
    ),
    metricCell(
      "Interruptions",
      `${num(m.interruptions.count)} · ${pct(m.interruptions.rate)}`,
      m.interruptions.rate < 0.15 ? "good" : m.interruptions.rate >= 0.3 ? "warn" : "ok",
      "Prompts sent while the agent was still working.",
    ),
    metricCell(
      "Tool success",
      pct(m.tool_success_rate),
      m.tool_success_rate >= 0.95 ? "good" : m.tool_success_rate < 0.85 ? "warn" : "ok",
      "Tool calls that completed without error.",
    ),
    metricCell(
      "Subagents",
      m.subagents.count > 0 ? `${num(m.subagents.count)} · ${dur(m.subagents.avg_duration_ms)} avg` : "0",
      m.subagents.count > 0 ? "good" : "ok",
      m.subagents.max_concurrent > 1 ? `up to ${m.subagents.max_concurrent} in parallel.` : "Delegated parallel work.",
    ),
    metricCell(
      "Worktree",
      m.worktree.used ? "Yes" : "No",
      m.worktree.used ? "good" : "ok",
      m.worktree.used ? "Isolated on a branch." : "Ran in the main checkout.",
    ),
    metricCell(
      "Batching",
      m.batching_score > 0 ? `${m.batching_score.toFixed(1)}×` : "—",
      m.batching_score >= 1.6 ? "good" : m.batching_score < 1.2 && m.tool_invocations >= 30 ? "warn" : "ok",
      "Avg tool calls per step — higher means fewer round-trips.",
    ),
  ].join("");
  return `<section><h2>How you drove the agent</h2><div class="metrics">${cells}</div></section>`;
}

function countedRows(items: Counted[]): string {
  const max = items.reduce((mx, i) => Math.max(mx, i.count), 0);
  return items
    .map((i) => {
      const w = max > 0 ? Math.max(4, Math.round((i.count / max) * 100)) : 0;
      return `
      <div class="rowbar">
        <span class="rowbar-label">${escapeHtml(i.name)}</span>
        <span class="rowbar-track"><span class="rowbar-fill" style="width:${w}%"></span></span>
        <span class="rowbar-num">${num(i.count)}</span>
      </div>`;
    })
    .join("");
}

function mcpHtml(m: CoachingMetrics): string {
  if (m.mcp_servers.length === 0) {
    return "";
  }
  return `
    <section>
      <h2>MCP servers used <span class="muted small">(${num(m.mcp_server_count)})</span></h2>
      ${countedRows(m.mcp_servers)}
    </section>`;
}

function skillTypeLabel(t: SkillStat["type"]): string {
  switch (t) {
    case "mcp_tool":
      return "MCP";
    case "skill":
      return "Skill";
    case "subagent":
      return "Subagent";
    case "slash_command":
      return "Command";
    default:
      return t;
  }
}

function skillsHtml(m: CoachingMetrics): string {
  const skills = m.skills_used.filter((s) => s.type !== "mcp_tool");
  if (skills.length === 0) {
    return "";
  }
  const rows = [...skills]
    .sort((a, b) => b.count - a.count)
    .map((s) => {
      const sr = typeof s.success_rate === "number" ? `<td class="num">${pct(s.success_rate)}</td>` : `<td class="num muted">—</td>`;
      return `<tr><td><span class="tag">${escapeHtml(skillTypeLabel(s.type))}</span> ${escapeHtml(s.name)}</td><td class="num">${num(s.count)}</td>${sr}</tr>`;
    })
    .join("");
  return `
    <section>
      <h2>Skills &amp; subagents</h2>
      <table>
        <thead><tr><th>What</th><th class="num">Uses</th><th class="num">Success</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function subagentHtml(m: CoachingMetrics): string {
  if (m.subagents.by_type.length === 0) {
    return "";
  }
  const rows = m.subagents.by_type
    .map(
      (t) =>
        `<tr><td>${escapeHtml(t.type)}</td><td class="num">${num(t.count)}</td><td class="num">${dur(t.avg_duration_ms)}</td></tr>`,
    )
    .join("");
  return `
    <section>
      <h2>Subagents <span class="muted small">(${num(m.subagents.count)}, ${dur(m.subagents.total_duration_ms)} total)</span></h2>
      <table>
        <thead><tr><th>Type</th><th class="num">Count</th><th class="num">Avg time</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function sparkline(values: number[]): string {
  if (values.length === 0) {
    return "";
  }
  const max = Math.max(1, ...values);
  const bars = values
    .map((v) => {
      const h = Math.max(2, Math.round((v / max) * 28));
      return `<span class="spark-bar" style="height:${h}px" title="${num(v)}"></span>`;
    })
    .join("");
  return `<span class="spark">${bars}</span>`;
}

function trendsHtml(trends: TrendsResponse | undefined): string {
  if (!trends || trends.daily.length === 0) {
    return "";
  }
  const m = trends.metrics;
  const days = trends.daily;
  return `
    <section>
      <h2>Your trends <span class="muted small">(${num(days.length)} active days, local history)</span></h2>
      <div class="trend-grid">
        <div class="trend-cell"><div class="trend-label">Prompts / day</div>${sparkline(days.map((d) => d.prompts))}</div>
        <div class="trend-cell"><div class="trend-label">Interruptions / day</div>${sparkline(days.map((d) => d.interruptions))}</div>
        <div class="trend-cell"><div class="trend-label">Subagents / day</div>${sparkline(days.map((d) => d.subagents))}</div>
        <div class="trend-cell"><div class="trend-label">Plan-mode %</div>${sparkline(days.map((d) => Math.round(d.plan_mode_adoption_rate * 100)))}</div>
      </div>
      <p class="muted small">Across all local sessions: ${num(m.prompts)} prompts, ${num(m.subagents.count)} subagents,
        ${pct(m.plan_mode_adoption_rate)} in plan mode, ${pct(m.interruptions.rate)} interrupted.</p>
    </section>`;
}

/**
 * Render the full coaching document. `snapshot` is the live session; `trends`
 * is the optional all-history rollup (also derived locally). Returns the
 * zero-state when there's nothing to show yet.
 */
export function renderCoachingHtml(
  snapshot: CoachingSnapshot | undefined,
  trends?: TrendsResponse,
): string {
  if (!snapshot || snapshot.metrics.prompts === 0) {
    return documentShell(zeroStateHtml());
  }
  const body = `
  <main class="report">
    ${heroHtml(snapshot)}
    ${insightsHtml(snapshot.insights)}
    ${driversHtml(snapshot.metrics)}
    ${mcpHtml(snapshot.metrics)}
    ${skillsHtml(snapshot.metrics)}
    ${subagentHtml(snapshot.metrics)}
    ${trendsHtml(trends)}
    <footer class="muted">
      Computed entirely on your machine from the local event log — works fully offline.
      Signed in, your dashboard adds cross-machine history.
    </footer>
  </main>`;
  return documentShell(body);
}

function zeroStateHtml(): string {
  return `
  <main class="report">
    <header class="hero">
      <p class="hero-eyebrow">Agent coaching</p>
      <div class="hero-amount muted">No sessions yet</div>
      <p class="hero-sub">Run an AI coding session (e.g. Claude Code) with the
        <code>promptconduit</code> hooks installed. Your coaching report builds here automatically — no internet needed.</p>
    </header>
    <section>
      <h2>What you'll see</h2>
      <p class="muted">Which MCP servers and skills you used, whether you planned before editing, how
        often you interrupted the agent, your subagent and worktree habits, and tailored tips to level up.</p>
    </section>
  </main>`;
}

function documentShell(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>${STYLES}</style>
</head>
<body>${body}</body>
</html>`;
}

const STYLES = `
  body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground);
         padding: 1.25rem 1.5rem; line-height: 1.5; }
  code { font-family: var(--vscode-editor-font-family, monospace);
         background: var(--vscode-textCodeBlock-background); padding: 0.05rem 0.3rem; border-radius: 0.25rem; }
  .report { max-width: 46rem; }
  h2 { font-size: 0.95rem; margin: 1.8rem 0 0.6rem; }
  .muted { color: var(--vscode-descriptionForeground); }
  .small { font-size: 0.85rem; }

  .badge { display: inline-block; font-size: 0.72rem; padding: 0.12rem 0.55rem; border-radius: 0.6rem;
           background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-right: 0.4rem; }
  .badge.subtle { background: transparent; color: var(--vscode-descriptionForeground);
                  border: 1px solid var(--vscode-panel-border); }
  .tag { display: inline-block; font-size: 0.68rem; padding: 0.02rem 0.4rem; border-radius: 0.4rem;
         background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }

  .hero { padding-bottom: 0.5rem; border-bottom: 1px solid var(--vscode-panel-border); }
  .hero-badges { margin-bottom: 0.85rem; }
  .hero-eyebrow { margin: 0; font-size: 0.85rem; color: var(--vscode-descriptionForeground);
                  text-transform: uppercase; letter-spacing: 0.04em; }
  .hero-amount { font-size: 2.4rem; font-weight: 650; line-height: 1.1; margin: 0.1rem 0; font-variant-numeric: tabular-nums; }
  .hero-amount.muted { font-size: 1.7rem; }
  .hero-unit { font-size: 1.1rem; font-weight: 400; color: var(--vscode-descriptionForeground); }
  .hero-sub { margin: 0.2rem 0; }

  /* Coaching list */
  .coaches { margin: 0.5rem 0 0; padding: 0; list-style: none; }
  .coach { padding: 0.6rem 0.8rem; margin-bottom: 0.5rem; border-radius: 0 0.3rem 0.3rem 0;
           background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-panel-border); }
  .coach.warn { border-left-color: var(--vscode-editorWarning-foreground, #cca700); }
  .coach.tip  { border-left-color: var(--vscode-textLink-foreground); }
  .coach.info { border-left-color: var(--vscode-charts-green, #3fb950); }
  .coach-head { display: flex; justify-content: space-between; align-items: baseline; gap: 0.5rem; }
  .coach-val { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--vscode-descriptionForeground); }
  .coach-detail { display: block; font-size: 0.9rem; color: var(--vscode-descriptionForeground); margin-top: 0.15rem; }
  .coach-more { margin-top: 0.4rem; }
  .coach-more summary { cursor: pointer; font-size: 0.85rem; color: var(--vscode-textLink-foreground); }
  .coach-more p { font-size: 0.88rem; margin: 0.4rem 0; }
  .coach a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .coach a:hover { text-decoration: underline; }

  /* Metrics grid */
  .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 0.6rem; }
  .metric { padding: 0.65rem 0.8rem; border-radius: 0.4rem; border: 1px solid var(--vscode-panel-border);
            border-left-width: 3px; background: var(--vscode-textBlockQuote-background); }
  .metric.good { border-left-color: var(--vscode-charts-green, #3fb950); }
  .metric.warn { border-left-color: var(--vscode-editorWarning-foreground, #cca700); }
  .metric.ok   { border-left-color: var(--vscode-panel-border); }
  .metric-value { font-size: 1.25rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .metric-label { font-size: 0.85rem; margin-top: 0.1rem; }
  .metric-hint { font-size: 0.78rem; margin-top: 0.25rem; }

  /* Row bars (MCP) */
  .rowbar { display: flex; align-items: center; gap: 0.6rem; margin: 0.3rem 0; }
  .rowbar-label { flex: 0 0 11rem; font-size: 0.88rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rowbar-track { flex: 1; height: 6px; background: var(--vscode-panel-border); border-radius: 3px; overflow: hidden; }
  .rowbar-fill { display: block; height: 100%; background: var(--vscode-textLink-foreground); }
  .rowbar-num { flex: 0 0 2.5rem; text-align: right; font-variant-numeric: tabular-nums; font-size: 0.88rem; }

  /* Tables */
  table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--vscode-panel-border); }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }

  /* Trends */
  .trend-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0.8rem; margin-top: 0.5rem; }
  .trend-cell { padding: 0.5rem 0.7rem; border: 1px solid var(--vscode-panel-border); border-radius: 0.4rem; }
  .trend-label { font-size: 0.8rem; color: var(--vscode-descriptionForeground); margin-bottom: 0.4rem; }
  .spark { display: flex; align-items: flex-end; gap: 2px; height: 30px; }
  .spark-bar { flex: 1; background: var(--vscode-textLink-foreground); border-radius: 1px 1px 0 0; min-width: 2px; }

  footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--vscode-panel-border); font-size: 0.85rem; }
`;
