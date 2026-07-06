import * as vscode from "vscode";
import { ConversationView } from "./state";
import { CostEvent, SessionSummary, ToolId, ToolSummary } from "./types";
import { buildTips } from "./tips";
import { buildEdgeCases } from "./edgeCases";
import { landingHtml } from "./landing";
import { anchorHtml, escapeHtml, learnMoreSectionHtml } from "./html";

/** Everything the breakdown renders: every conversation plus the active key. */
export interface BreakdownView {
  /** Conversations, most-recently-active first. */
  conversations: ConversationView[];
  activeKey?: string;
}

// Full precision for per-request and per-model rows.
function fmtUSD(n: number): string {
  return `$${n.toFixed(4)}`;
}

// Headline precision: cents for real amounts, sub-cent for tiny sessions, so the
// hero figure reads like money rather than scientific notation.
function fmtUSDHero(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function num(n: number): string {
  return n.toLocaleString();
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

// Human label for a tool id.
function toolName(tool: ToolId): string {
  switch (tool) {
    case "claude-code":
      return "Claude Code";
    case "cursor":
      return "Cursor";
    default:
      return tool || "your assistant";
  }
}

// "Claude API pay-as-you-go rates" vs the tool-agnostic phrasing for others
// (Cursor, or a mix of tools — the empty-string primary).
function ratesLabel(tool: ToolId): string {
  return tool === "claude-code"
    ? "Claude API pay-as-you-go rates"
    : "API pay-as-you-go rates";
}

// The subscription a user is likely on for this tool.
function subscriptionName(tool: ToolId): string {
  if (tool === "cursor") {
    return "Cursor";
  }
  if (tool === "claude-code") {
    return "Claude";
  }
  return "Claude or Cursor";
}

// How accurate the token counts are, as a short badge label.
function sourceLabel(source: string): string {
  switch (source) {
    case "exact":
      return "exact tokens";
    case "estimate":
      return "estimated";
    case "reconciled":
      return "reconciled";
    default:
      return source;
  }
}

// "Read ×3, Bash ×2" from a ToolSummary, or "" when there are no names.
function toolList(tools: ToolSummary | undefined): string {
  if (!tools?.by_name) {
    return "";
  }
  return Object.entries(tools.by_name)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${escapeHtml(name)} ×${n}`)
    .join(", ");
}

function shortTime(ts: string): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? escapeHtml(ts) : d.toLocaleTimeString();
}

function totalTokens(s: SessionSummary | undefined): number {
  const t = s?.totals;
  return t ? t.input + t.output + t.cache_read + t.cache_write : 0;
}

// ---- section renderers (pure; data in, HTML out) ----

// The hero: the counterfactual API cost framed as "what this would have cost
// without your subscription" — the headline ask, now summed ACROSS every
// tracked session (Claude Code and Cursor together). Priced usage shows the
// dollar figure; tokens-but-no-rate shows "Unpriced" and points at the
// edge-case section rather than a misleading $0.00.
function heroHtml(view: BreakdownView): string {
  const totalCost = view.conversations.reduce((s, c) => s + c.summary.totals.cost_total, 0);
  const tokens = view.conversations.reduce((s, c) => s + totalTokens(c.summary), 0);
  const tools = [...new Set(view.conversations.map((c) => c.tool).filter(Boolean))];
  const sources = [...new Set(view.conversations.map((c) => c.summary.source).filter(Boolean))];
  const n = view.conversations.length;
  const scope = n === 1 ? "This session" : `These ${n} sessions`;
  const badges =
    tools.map((t) => `<span class="badge">${escapeHtml(toolName(t))}</span>`).join("") +
    sources.map((s) => `<span class="badge subtle">${escapeHtml(sourceLabel(s))}</span>`).join("");
  const primaryTool: ToolId = tools.length === 1 ? tools[0] : "";

  if (totalCost > 0) {
    return `
    <header class="hero">
      <div class="hero-badges">${badges}</div>
      <p class="hero-eyebrow">${escapeHtml(scope)} would cost</p>
      <div class="hero-amount">${fmtUSDHero(totalCost)}</div>
      <p class="hero-sub">at ${escapeHtml(ratesLabel(primaryTool))}.</p>
      <p class="hero-note">If you're on a ${escapeHtml(subscriptionName(primaryTool))} subscription, this usage
        is already included — this is what the same tokens would bill à la carte.</p>
    </header>`;
  }

  return `
    <header class="hero">
      <div class="hero-badges">${badges}</div>
      <p class="hero-eyebrow">Tokens tracked</p>
      <div class="hero-amount muted">Unpriced</div>
      <p class="hero-sub">${num(tokens)} tokens, but no rate to turn them into dollars —
        see <em>Reading these numbers</em> below.</p>
    </header>`;
}

// One request = one prompt turn. The bar shows its cost relative to the session's
// most expensive prompt so a glance reveals which prompts drove spend.
function promptRowHtml(ev: CostEvent, maxCost: number): string {
  const priced = ev.model_priced;
  const cost = priced ? fmtUSD(ev.cost.total) : "unpriced";
  const widthPct = priced && maxCost > 0 ? Math.max(3, Math.round((ev.cost.total / maxCost) * 100)) : 0;
  const bar = widthPct > 0 ? `<div class="bar"><div class="bar-fill" style="width:${widthPct}%"></div></div>` : "";
  const toolCount = ev.tools?.total ?? 0;
  const tier = ev.signals?.tier && ev.signals.tier !== "unknown" ? ` · ${escapeHtml(ev.signals.tier)}` : "";
  const meta = `${escapeHtml(ev.model)}${tier} · ${toolCount} tool${toolCount === 1 ? "" : "s"} · ${shortTime(ev.ts)}`;
  const cacheLine =
    ev.signals !== undefined
      ? `<span>cache hit ${pct(ev.signals.cache_hit_rate)}</span><span>fresh input ${pct(ev.signals.input_token_share)}</span>`
      : "";
  const tools = toolList(ev.tools);
  const toolsLine = tools ? `<div class="drill muted">tools: ${tools}</div>` : "";
  return `
    <details class="prompt">
      <summary>
        <span class="prompt-head"><span class="prompt-cost">${cost}</span><span class="muted">${meta}</span></span>
        ${bar}
      </summary>
      <div class="drill">
        <span>in ${num(ev.tokens.input)}</span><span>out ${num(ev.tokens.output)}</span>
        <span>cache read ${num(ev.tokens.cache_read)}</span><span>cache write ${num(ev.tokens.cache_write)}</span>
      </div>
      <div class="drill muted">${cacheLine}</div>
      ${toolsLine}
    </details>`;
}

// How many per-prompt rows to render. Every request is retained in memory and
// counted in the header; we cap only the rendered DOM so a long session (many
// hundreds of prompts) doesn't build a sluggish webview. Older prompts stay on
// disk in ~/.promptconduit/events.jsonl.
const PROMPT_RENDER_LIMIT = 100;

function perPromptHtml(recent: CostEvent[]): string {
  if (!recent || recent.length === 0) {
    return "";
  }
  const items = [...recent].reverse(); // newest first
  // Scale bars against the true most-expensive prompt across the whole session,
  // even when it's older than the rows we render.
  const maxCost = items.reduce((m, e) => (e.model_priced ? Math.max(m, e.cost.total) : m), 0);
  const shown = items.slice(0, PROMPT_RENDER_LIMIT);
  const hidden = items.length - shown.length;
  const rows = shown.map((ev) => promptRowHtml(ev, maxCost)).join("");
  const moreNote =
    hidden > 0
      ? `<p class="muted small">+${hidden} older prompt${hidden === 1 ? "" : "s"} not shown here —
        full history is kept in <code>~/.promptconduit/events.jsonl</code>.</p>`
      : "";
  return `
    <section>
      <h2>Cost per prompt</h2>
      <p class="muted small">Each row is one request to the model, newest first. The bar shows its
        share of the most expensive prompt — click a row for the token split.</p>
      ${rows}
      ${moreNote}
    </section>`;
}

// Short, human-friendly session id (keep the tail, the most distinctive part).
function shortKey(key: string): string {
  return key.length > 12 ? `…${key.slice(-8)}` : key;
}

function lastActiveLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "";
  }
  return new Date(ms).toLocaleTimeString();
}

// One conversation's card: header line (tool, workspace, id, totals) plus an
// expandable body with its per-prompt rows and per-model table. The active
// session renders open; the rest collapsed.
function sessionCardHtml(c: ConversationView, isActive: boolean): string {
  const s = c.summary;
  const cost = s.totals.cost_total > 0 ? fmtUSDHero(s.totals.cost_total) : "unpriced";
  const workspace = c.lastEvent?.cwd_base ? escapeHtml(c.lastEvent.cwd_base) : "";
  const requests = c.recent.length;
  const when = lastActiveLabel(c.lastActivity);
  const activePill = isActive ? `<span class="badge active-pill">active</span>` : "";
  const meta = [workspace, `${requests} request${requests === 1 ? "" : "s"}`, when]
    .filter(Boolean)
    .join(" · ");
  return `
    <details class="session"${isActive ? " open" : ""}>
      <summary>
        <span class="session-head">
          <span class="badge">${escapeHtml(toolName(c.tool))}</span>
          <span class="session-cost">${cost}</span>
          <span class="muted">${meta}</span>
          <span class="muted session-id">${escapeHtml(shortKey(c.key))}</span>
          ${activePill}
        </span>
      </summary>
      ${perPromptHtml(c.recent)}
      ${byModelHtml(s)}
    </details>`;
}

// Every tracked session, active first — the multi-session core of the panel.
function sessionsHtml(view: BreakdownView): string {
  if (view.conversations.length === 0) {
    return "";
  }
  const cards = view.conversations
    .map((c) => sessionCardHtml(c, c.key === view.activeKey))
    .join("");
  return `
    <section>
      <h2>By session</h2>
      <p class="muted small">Every session PromptConduit has tracked locally, most recent first —
        Claude Code and Cursor side by side. Expand one for its prompts and models.</p>
      ${cards}
    </section>`;
}

function metricHtml(label: string, value: string, state: "good" | "ok" | "warn", hint: string): string {
  return `
    <div class="metric ${state}">
      <div class="metric-value">${escapeHtml(value)}</div>
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-hint muted">${escapeHtml(hint)}</div>
    </div>`;
}

// A scannable health readout of the session's cost drivers, from the CLI's
// signals. Shown only when signals exist (priced v2+ session).
function driversHtml(session: SessionSummary | undefined): string {
  const sig = session?.signals;
  if (!sig) {
    return "";
  }
  const toolCalls = session?.tools?.total ?? sig.tool_calls ?? 0;
  const cells = [
    metricHtml(
      "Cache hit rate",
      pct(sig.cache_hit_rate),
      sig.cache_hit_rate >= 0.6 ? "good" : sig.cache_hit_rate < 0.4 ? "warn" : "ok",
      "Higher is cheaper — cached reads cost ~10× less than fresh input.",
    ),
    metricHtml(
      "Fresh input",
      pct(sig.input_token_share),
      sig.input_token_share <= 0.3 ? "good" : sig.input_token_share >= 0.6 ? "warn" : "ok",
      "Share of input that was new, not cached. Lower is cheaper.",
    ),
    metricHtml(
      "Model tier",
      sig.tier && sig.tier !== "unknown" ? sig.tier : "—",
      sig.tier === "premium" ? "warn" : "ok",
      "Premium models cost several times more per token.",
    ),
    metricHtml(
      "Tool calls",
      num(toolCalls),
      toolCalls >= 40 ? "warn" : "ok",
      "More round-trips mean more output tokens.",
    ),
  ].join("");
  return `<section><h2>What's driving your cost</h2><div class="metrics">${cells}</div></section>`;
}

function tipsHtml(session: SessionSummary | undefined, lastEvent: CostEvent | undefined): string {
  const tips = buildTips(session, lastEvent);
  if (tips.length === 0) {
    return "";
  }
  const items = tips
    .map((tip) => {
      const link = tip.link ? ` ${anchorHtml(tip.link.href, "Learn how →")}` : "";
      return `<li><strong>${escapeHtml(tip.title)}</strong>${escapeHtml(tip.detail)}${link}</li>`;
    })
    .join("");
  return `<section><h2>Make it cheaper</h2><ul class="tips">${items}</ul></section>`;
}

function edgeCasesHtml(session: SessionSummary | undefined, lastEvent: CostEvent | undefined): string {
  const cases = buildEdgeCases(session, lastEvent);
  if (cases.length === 0) {
    return "";
  }
  const items = cases
    .map((c) => {
      const link = c.link ? ` ${anchorHtml(c.link.href, `${c.link.label} →`)}` : "";
      return `
      <li class="edge ${c.severity}">
        <strong>${escapeHtml(c.title)}</strong>
        <span class="edge-detail">${escapeHtml(c.detail)}</span>
        <span class="edge-fix"><em>Fix:</em> ${escapeHtml(c.resolution)}${link}</span>
      </li>`;
    })
    .join("");
  return `<section><h2>Reading these numbers</h2><ul class="edges">${items}</ul></section>`;
}

function byModelHtml(session: SessionSummary | undefined): string {
  const models = session?.by_model ?? [];
  const rows = models
    .map(
      (m) => `
      <tr>
        <td>${escapeHtml(m.model)}${m.model_priced ? "" : ' <span class="badge subtle">unpriced</span>'}</td>
        <td class="num">${num(m.tokens.input)}</td>
        <td class="num">${num(m.tokens.output)}</td>
        <td class="num">${num(m.tokens.cache_read)}</td>
        <td class="num">${num(m.tokens.cache_write)}</td>
        <td class="num">${m.model_priced ? fmtUSD(m.cost_total) : "—"}</td>
      </tr>`,
    )
    .join("");
  return `
    <section>
      <h2>By model</h2>
      <table>
        <thead>
          <tr>
            <th>Model</th><th class="num">Input</th><th class="num">Output</th>
            <th class="num">Cache read</th><th class="num">Cache write</th><th class="num">Cost</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="6" class="muted">No turns yet.</td></tr>`}</tbody>
      </table>
    </section>`;
}

/**
 * Pure renderer for a single-session cost breakdown (default cost click).
 */
export function renderSessionBreakdownHtml(conv: ConversationView | undefined): string {
  if (!conv) {
    return landingDocument();
  }
  const session = conv.summary;
  const lastEvent = conv.lastEvent;
  const tool: ToolId = conv.tool ?? "";
  const cost = session.totals.cost_total;
  const badges =
    `<span class="badge">${escapeHtml(toolName(tool))}</span>` +
    `<span class="badge subtle">${escapeHtml(sourceLabel(session.source))}</span>`;
  const hero =
    cost > 0
      ? `
    <header class="hero">
      <div class="hero-badges">${badges}</div>
      <p class="hero-eyebrow">This session would cost</p>
      <div class="hero-amount">${fmtUSDHero(cost)}</div>
      <p class="hero-sub">at ${escapeHtml(ratesLabel(tool))}.</p>
      <p class="hero-note">If you're on a ${escapeHtml(subscriptionName(tool))} subscription, this usage
        is already included — this is what the same tokens would bill à la carte.</p>
    </header>`
      : `
    <header class="hero">
      <div class="hero-badges">${badges}</div>
      <p class="hero-eyebrow">Tokens tracked</p>
      <div class="hero-amount muted">Unpriced</div>
      <p class="hero-sub">${num(totalTokens(session))} tokens, but no rate to turn them into dollars —
        see <em>Reading these numbers</em> below.</p>
    </header>`;
  const body = `
  <main class="report">
    ${hero}
    ${perPromptHtml(conv.recent)}
    ${driversHtml(session)}
    ${tipsHtml(session, lastEvent)}
    ${edgeCasesHtml(session, lastEvent)}
    ${byModelHtml(session)}
    ${learnMoreSectionHtml(tool)}
    <footer class="muted">
      Computed entirely on your machine from the local event log. None of your data is sent anywhere.
    </footer>
  </main>`;
  return documentShell(body);
}

/**
 * Pure renderer for the cost breakdown document. Exported so the webview preview
 * and unit tests can render it without a live editor. Returns the zero-state
 * landing document when nothing has been tracked yet.
 *
 * Multi-session: the hero sums every conversation; "By session" lists them all
 * (Claude Code + Cursor); the educational sections (drivers/tips/edge cases)
 * are computed from the ACTIVE session, where advice is actionable.
 */
export function renderBreakdownHtml(view: BreakdownView): string {
  if (view.conversations.length === 0) {
    return landingDocument();
  }
  const active =
    view.conversations.find((c) => c.key === view.activeKey) ?? view.conversations[0];
  const session = active.summary;
  const lastEvent = active.lastEvent;
  const tool: ToolId = active.tool ?? "";
  const body = `
  <main class="report">
    ${heroHtml(view)}
    ${sessionsHtml(view)}
    ${driversHtml(session)}
    ${tipsHtml(session, lastEvent)}
    ${edgeCasesHtml(session, lastEvent)}
    ${learnMoreSectionHtml(tool)}
    <footer class="muted">
      Computed entirely on your machine from the local event log. None of your data is sent anywhere.
    </footer>
  </main>`;
  return documentShell(body);
}

// Shared document shell: DOCTYPE, charset, and the breakdown's theme styles.
// Script-free (the webview runs with enableScripts:false); all interactivity is
// native <details>/<a>.
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

// Wrap the landing body (which ships its own scoped .landing styles) in the
// shared shell so the zero-state inherits the same base body/code rules.
function landingDocument(): string {
  return documentShell(landingHtml());
}

const STYLES = `
  body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground);
         padding: 1.25rem 1.5rem; line-height: 1.5; }
  code { font-family: var(--vscode-editor-font-family, monospace);
         background: var(--vscode-textCodeBlock-background); padding: 0.05rem 0.3rem; border-radius: 0.25rem; }
  .report { max-width: 46rem; }
  h2 { font-size: 0.95rem; margin: 2rem 0 0.6rem; }
  .muted { color: var(--vscode-descriptionForeground); }
  .small { font-size: 0.85rem; }
  em { font-style: normal; font-weight: 600; }

  .badge { display: inline-block; font-size: 0.72rem; padding: 0.12rem 0.55rem; border-radius: 0.6rem;
           background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-right: 0.4rem; }
  .badge.subtle { background: transparent; color: var(--vscode-descriptionForeground);
                  border: 1px solid var(--vscode-panel-border); }

  /* Hero */
  .hero { padding-bottom: 0.5rem; border-bottom: 1px solid var(--vscode-panel-border); }
  .hero-badges { margin-bottom: 0.85rem; }
  .hero-eyebrow { margin: 0; font-size: 0.85rem; color: var(--vscode-descriptionForeground);
                  text-transform: uppercase; letter-spacing: 0.04em; }
  .hero-amount { font-size: 2.6rem; font-weight: 650; line-height: 1.1; margin: 0.1rem 0; font-variant-numeric: tabular-nums; }
  .hero-amount.muted { font-size: 1.8rem; }
  .hero-sub { margin: 0.2rem 0; }
  .hero-note { margin: 0.5rem 0 0; max-width: 38rem; color: var(--vscode-descriptionForeground); font-size: 0.9rem; }

  /* Sessions */
  details.session { border: 1px solid var(--vscode-panel-border); border-radius: 0.4rem;
                    padding: 0.4rem 0.8rem; margin-bottom: 0.55rem;
                    background: var(--vscode-textBlockQuote-background); }
  details.session > summary { cursor: pointer; }
  .session-head { display: inline-flex; gap: 0.55rem; align-items: baseline; flex-wrap: wrap; }
  .session-cost { font-weight: 650; font-variant-numeric: tabular-nums; }
  .session-id { font-size: 0.78rem; }
  .badge.active-pill { background: var(--vscode-charts-green, #3fb950); color: #fff; }
  details.session section { margin-left: 0.2rem; }
  details.session h2 { font-size: 0.85rem; margin: 1rem 0 0.4rem; }

  /* Cost per prompt */
  details.prompt { border-bottom: 1px solid var(--vscode-panel-border); padding: 0.5rem 0; }
  details.prompt summary { cursor: pointer; list-style-position: outside; }
  .prompt-head { display: inline-flex; gap: 0.5rem; align-items: baseline; flex-wrap: wrap; }
  .prompt-cost { font-weight: 600; font-variant-numeric: tabular-nums; }
  .bar { height: 4px; border-radius: 2px; background: var(--vscode-panel-border); margin: 0.4rem 0 0.1rem; overflow: hidden; }
  .bar-fill { height: 100%; background: var(--vscode-textLink-foreground); border-radius: 2px; }
  .drill { margin: 0.4rem 0 0.2rem 1rem; font-size: 0.88rem; }
  .drill span { display: inline-block; margin-right: 1rem; font-variant-numeric: tabular-nums; }

  /* Drivers */
  .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 0.6rem; }
  .metric { padding: 0.65rem 0.8rem; border-radius: 0.4rem; border: 1px solid var(--vscode-panel-border);
            border-left-width: 3px; background: var(--vscode-textBlockQuote-background); }
  .metric.good { border-left-color: var(--vscode-charts-green, #3fb950); }
  .metric.warn { border-left-color: var(--vscode-editorWarning-foreground, #cca700); }
  .metric.ok   { border-left-color: var(--vscode-panel-border); }
  .metric-value { font-size: 1.3rem; font-weight: 600; font-variant-numeric: tabular-nums; text-transform: capitalize; }
  .metric-label { font-size: 0.85rem; margin-top: 0.1rem; }
  .metric-hint { font-size: 0.78rem; margin-top: 0.25rem; }

  /* Tips */
  .tips { margin: 0.5rem 0 0; padding: 0; list-style: none; }
  .tips li { padding: 0.55rem 0.8rem; margin-bottom: 0.45rem; border-left: 3px solid var(--vscode-textLink-foreground);
             background: var(--vscode-textBlockQuote-background); border-radius: 0 0.3rem 0.3rem 0; }
  .tips strong { display: block; margin-bottom: 0.1rem; }
  .tips a { color: var(--vscode-textLink-foreground); text-decoration: none; white-space: nowrap; }
  .tips a:hover { text-decoration: underline; }

  /* Edge cases */
  .edges { margin: 0.5rem 0 0; padding: 0; list-style: none; }
  .edges .edge { padding: 0.55rem 0.8rem; margin-bottom: 0.45rem; border-radius: 0 0.3rem 0.3rem 0;
                 background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-panel-border); }
  .edges .edge.warn { border-left-color: var(--vscode-editorWarning-foreground, #cca700); }
  .edges .edge.info { border-left-color: var(--vscode-textLink-foreground); }
  .edges strong { display: block; margin-bottom: 0.15rem; }
  .edges .edge-detail { display: block; font-size: 0.9rem; color: var(--vscode-descriptionForeground); }
  .edges .edge-fix { display: block; font-size: 0.9rem; margin-top: 0.3rem; }
  .edges a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .edges a:hover { text-decoration: underline; }

  /* Tables */
  table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--vscode-panel-border); }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }

  /* Learn more */
  .links { list-style: none; padding: 0; margin: 0.5rem 0 0; }
  .links li { margin: 0.4rem 0; }
  .links a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .links a:hover { text-decoration: underline; }
  .links .desc { color: var(--vscode-descriptionForeground); }

  footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--vscode-panel-border); font-size: 0.85rem; }
`;

/**
 * CostPanel owns the click-through breakdown webview. A single reused panel;
 * calling show() again reveals and refreshes it. Rendering is delegated to the
 * pure {@link renderBreakdownHtml} so the same output is unit-tested and
 * preview-rendered. Scripts are disabled — all interactivity is native HTML.
 */
export class CostPanel {
  private static current: CostPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private mode: "session" | "all" = "session";

  static showSession(conv: ConversationView | undefined): void {
    CostPanel.showInternal("session", conv);
  }

  static showAll(view: BreakdownView): void {
    if (CostPanel.current && !CostPanel.current.disposed) {
      CostPanel.current.mode = "all";
      CostPanel.current.panel.reveal(vscode.ViewColumn.Active);
      CostPanel.current.updateAll(view);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "promptconduitCost",
      "AI Cost Breakdown — All Sessions",
      vscode.ViewColumn.Active,
      { enableScripts: false, retainContextWhenHidden: true },
    );
    CostPanel.current = new CostPanel(panel, "all");
    CostPanel.current.updateAll(view);
  }

  /** @deprecated Use showSession or showAll */
  static show(view: BreakdownView): void {
    CostPanel.showAll(view);
  }

  private static showInternal(mode: "session", conv: ConversationView | undefined): void {
    if (CostPanel.current && !CostPanel.current.disposed) {
      CostPanel.current.mode = mode;
      CostPanel.current.panel.reveal(vscode.ViewColumn.Active);
      CostPanel.current.updateSession(conv);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "promptconduitCost",
      "AI Cost Breakdown",
      vscode.ViewColumn.Active,
      { enableScripts: false, retainContextWhenHidden: true },
    );
    CostPanel.current = new CostPanel(panel, mode);
    CostPanel.current.updateSession(conv);
  }

  /** Push fresh data into an already-open panel (called on new records). */
  static refreshSession(conv: ConversationView | undefined): void {
    if (CostPanel.current && !CostPanel.current.disposed && CostPanel.current.mode === "session") {
      CostPanel.current.updateSession(conv);
    }
  }

  static refreshAll(view: BreakdownView): void {
    if (CostPanel.current && !CostPanel.current.disposed && CostPanel.current.mode === "all") {
      CostPanel.current.updateAll(view);
    }
  }

  /** @deprecated Use refreshSession or refreshAll */
  static refresh(view: BreakdownView): void {
    CostPanel.refreshAll(view);
  }

  private constructor(panel: vscode.WebviewPanel, mode: "session" | "all") {
    this.panel = panel;
    this.mode = mode;
    this.panel.onDidDispose(() => {
      this.disposed = true;
      if (CostPanel.current === this) {
        CostPanel.current = undefined;
      }
    });
  }

  private updateSession(conv: ConversationView | undefined): void {
    this.panel.webview.html = renderSessionBreakdownHtml(conv);
  }

  private updateAll(view: BreakdownView): void {
    this.panel.webview.html = renderBreakdownHtml(view);
  }
}
