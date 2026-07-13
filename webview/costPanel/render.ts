// Cost Breakdown webview renderer: CostPanelState -> HTML strings.
// Pure (no DOM, no vscode) so every section is unit-testable in plain node.
//
// Design: a precision cost ledger. Tabular mono numerals, small-caps section
// labels, hairline rules, ink-bar cost fills, a vertical spine connecting
// prompts, mini gantt lanes for subagents, and a syntax-lit raw-JSON "tape".
// Everything derives from --vscode-* theme variables (light & dark for free).

import type { CostPanelState, SessionView } from "../../src/costPanel/protocol";
import type { PromptGroup, PromptSubagent, PromptToolCall } from "../../src/promptGroup";
import type { CostEvent, ModelTotal, SessionSummary, Tokens } from "../../src/types";
import { compareModels, COMPARISON_CAVEAT, ModelComparison } from "../../src/costPanel/comparison";
import { glossaryFor } from "../../src/costPanel/glossary";
import { escapeHtml, highlightJson } from "./jsonHighlight";

// ---------- formatting ----------

export function fmtUSD(n: number): string {
  if (n < 0.01) {
    return `$${n.toFixed(4)}`;
  }
  return `$${n.toFixed(2)}`;
}

function fmtUSDHero(n: number): string {
  return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function fmtDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) {
    return "";
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const s = Math.round(ms / 1000);
  if (s < 90) {
    return `${s}s`;
  }
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function shortTime(ts: string | undefined): string {
  if (!ts) {
    return "";
  }
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) {
    return "";
  }
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function shortKey(key: string): string {
  return key.length > 12 ? `…${key.slice(-8)}` : key;
}

// ---------- glossary tooltips ----------

/**
 * A term with a hover/focus tooltip card from the glossary. Falls back to the
 * bare label when the key is unknown so copy never silently disappears.
 */
export function termHtml(key: string, label: string): string {
  const entry = glossaryFor(key);
  if (!entry) {
    return escapeHtml(label);
  }
  const more = entry.href
    ? ` <a class="tip-more" href="${escapeHtml(entry.href)}">Learn more →</a>`
    : "";
  return `<span class="term" tabindex="0">${escapeHtml(label)}<span class="tip" role="tooltip"><strong>${escapeHtml(entry.term)}</strong> ${escapeHtml(entry.short)}${more}</span></span>`;
}

// ---------- aggregation helpers ----------

function groupCost(g: PromptGroup): { usd: number; anyPriced: boolean } {
  let usd = 0;
  let anyPriced = false;
  for (const r of g.requests) {
    if (r.model_priced) {
      usd += r.cost.total;
      anyPriced = true;
    }
  }
  return { usd, anyPriced };
}

function groupTokens(g: PromptGroup): Tokens {
  const t: Tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  for (const r of g.requests) {
    t.input += r.tokens.input;
    t.output += r.tokens.output;
    t.cache_read += r.tokens.cache_read;
    t.cache_write += r.tokens.cache_write;
  }
  return t;
}

/** Aggregate a group's requests into one ModelTotal for its dominant model. */
export function groupModelTotal(g: PromptGroup): ModelTotal | undefined {
  const byModel = new Map<string, ModelTotal>();
  for (const r of g.requests) {
    const key = r.model || "unknown";
    let mt = byModel.get(key);
    if (!mt) {
      mt = {
        model: key,
        model_priced: r.model_priced,
        tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        cost_total: 0,
      };
      byModel.set(key, mt);
    }
    mt.model_priced = mt.model_priced || r.model_priced;
    mt.tokens.input += r.tokens.input;
    mt.tokens.output += r.tokens.output;
    mt.tokens.cache_read += r.tokens.cache_read;
    mt.tokens.cache_write += r.tokens.cache_write;
    mt.cost_total += r.cost.total;
  }
  return [...byModel.values()].sort((a, b) => b.cost_total - a.cost_total)[0];
}

// ---------- badges ----------

const MODE_LABELS: Record<string, string> = {
  plan: "plan mode",
  auto: "auto",
  acceptEdits: "accept edits",
  default: "default",
  bypassPermissions: "bypass permissions",
};

export function modeBadgeHtml(mode: string | undefined): string {
  if (!mode || !MODE_LABELS[mode]) {
    return "";
  }
  const label = MODE_LABELS[mode];
  return `<span class="chip chip-mode chip-${escapeHtml(mode)}">${termHtml(`permission_mode_${mode}`, label)}</span>`;
}

function toolBadge(tool: string): string {
  const label = tool === "claude-code" ? "Claude Code" : tool === "cursor" ? "Cursor" : tool || "session";
  return `<span class="chip chip-tool">${escapeHtml(label)}</span>`;
}

// ---------- VCS context line ----------

export function vcsLineHtml(s: SessionView): string {
  const v = s.vcs;
  if (!v || (!v.repo && !v.branch)) {
    return "";
  }
  const parts: string[] = [];
  const repoBranch = `${v.repo ?? ""}${v.branch ? ` @ ${v.branch}` : ""}`.trim();
  if (repoBranch) {
    const href = v.branch_url || v.repo_url;
    parts.push(
      href
        ? `<a href="${escapeHtml(href)}">${escapeHtml(repoBranch)}</a>`
        : escapeHtml(repoBranch),
    );
  }
  if (v.pr?.number && v.pr_url) {
    const state = v.pr.state ? ` · ${v.pr.state}` : "";
    const title = v.pr.title ? ` ${v.pr.title}` : "";
    parts.push(
      `<a href="${escapeHtml(v.pr_url)}">PR #${v.pr.number}${escapeHtml(title)}</a><span class="muted">${escapeHtml(state)}</span>`,
    );
  } else if (v.pr_url) {
    parts.push(`<a href="${escapeHtml(v.pr_url)}">open PR</a>`);
  }
  if (v.is_worktree) {
    parts.push(`<span class="chip chip-wt">worktree</span>`);
  }
  return `<div class="vcs-line">${parts.join('<span class="dot">·</span>')}</div>`;
}

// ---------- model comparison ----------

export function comparisonHtml(mt: ModelTotal | undefined, tool: string, scope: string): string {
  if (!mt || mt.cost_total <= 0) {
    return "";
  }
  const result = compareModels(mt, tool);
  if ("unpriced" in result) {
    return `<div class="compare"><span class="label">What if</span>
      <p class="muted small">Can't compare — no published rate for <code>${escapeHtml(mt.model)}</code>.</p></div>`;
  }
  if (result.length === 0) {
    return "";
  }
  const rows = result
    .map((c: ModelComparison) => {
      const cls = c.cheaper ? "save" : "spend";
      const pctAbs = Math.abs(Math.round(c.deltaPct * 100));
      const delta = c.cheaper
        ? `would have saved ${fmtUSD(Math.abs(c.deltaUsd))} (−${pctAbs}%)`
        : `would have cost ${fmtUSD(Math.abs(c.deltaUsd))} more (+${pctAbs}%)`;
      const star = c.derivedCacheRates ? `<span class="muted">*</span>` : "";
      return `<div class="cmp-row">
        <span class="cmp-model">${escapeHtml(c.model)}${star}</span>
        <span class="cmp-delta ${cls}">${delta}</span>
        <span class="cmp-alt muted">${fmtUSD(c.altUsd)} total</span>
      </div>`;
    })
    .join("");
  const derivedNote = result.some((c) => c.derivedCacheRates)
    ? `<p class="muted small">* cache rates estimated from Anthropic's standard multipliers.</p>`
    : "";
  return `<div class="compare">
    <span class="label">What if — ${escapeHtml(scope)} used a different model</span>
    <p class="muted small">You used <code>${escapeHtml(mt.model)}</code> for ${fmtUSD(mt.cost_total)}. Same tokens, other rates:</p>
    ${rows}
    ${derivedNote}
    <p class="muted small caveat">${escapeHtml(COMPARISON_CAVEAT)}</p>
  </div>`;
}

// ---------- tool calls ----------

function toolCallRow(t: PromptToolCall): string {
  const status = t.ok
    ? `<span class="ok" title="succeeded">●</span>`
    : `<span class="fail" title="failed">●</span>`;
  const chips: string[] = [];
  if (t.mcpServer) {
    chips.push(`<span class="chip chip-mcp">${termHtml("mcp_server", t.mcpServer)}</span>`);
  }
  if (t.skill) {
    chips.push(`<span class="chip">skill: ${escapeHtml(t.skill)}</span>`);
  }
  if (t.agentType) {
    chips.push(`<span class="chip">${termHtml("subagent", t.agentType)}</span>`);
  }
  const dur = fmtDuration(t.durationMs);
  return `<div class="tc-row">${status}<span class="tc-name">${escapeHtml(t.name)}</span>${chips.join("")}<span class="tc-dur muted">${dur}</span></div>`;
}

export function toolCallsHtml(g: PromptGroup): string {
  if (g.toolCalls.length === 0) {
    return "";
  }
  const failed = g.toolCalls.filter((t) => !t.ok).length;
  const failNote = failed > 0 ? ` · <span class="fail-text">${failed} failed</span>` : "";
  const dropped = g.droppedToolCalls
    ? `<p class="muted small">+${g.droppedToolCalls} more tool calls not retained.</p>`
    : "";
  return `<details class="sub" data-exp="${escapeHtml(g.id)}:tools">
    <summary><span class="label">Tool calls (${g.toolCalls.length})${failNote}</span></summary>
    <div class="tc-list">${g.toolCalls.map(toolCallRow).join("")}</div>
    ${dropped}
  </details>`;
}

// ---------- subagents (mini gantt) ----------

export function subagentsHtml(g: PromptGroup): string {
  if (g.subagents.length === 0) {
    return "";
  }
  const totalUsd = g.subagents.reduce((s, a) => s + (a.usdTotal ?? 0), 0);
  const usdNote = totalUsd > 0 ? ` · ${fmtUSD(totalUsd)}` : "";

  // Timeline geometry: offsets from the earliest start across the group.
  const starts = g.subagents
    .map((a) => Date.parse(a.startedAt ?? ""))
    .filter((n) => !Number.isNaN(n));
  const base = starts.length > 0 ? Math.min(...starts) : NaN;
  const span = g.subagents.reduce((max, a) => {
    const st = Date.parse(a.startedAt ?? "");
    if (Number.isNaN(st) || !a.durationMs) {
      return max;
    }
    return Math.max(max, st - base + a.durationMs);
  }, 0);

  const lanes = g.subagents
    .map((a: PromptSubagent) => {
      const st = Date.parse(a.startedAt ?? "");
      const hasGeom = !Number.isNaN(base) && !Number.isNaN(st) && span > 0 && !!a.durationMs;
      const left = hasGeom ? ((st - base) / span) * 100 : 0;
      const width = hasGeom ? Math.max(1.5, ((a.durationMs ?? 0) / span) * 100) : 0;
      const bar = hasGeom
        ? `<div class="lane"><div class="lane-bar" data-left="${left.toFixed(1)}" data-w="${width.toFixed(1)}"></div></div>`
        : "";
      const meta = [
        a.model ? escapeHtml(a.model) : "",
        a.requests ? `${a.requests} req` : "",
        fmtDuration(a.durationMs),
        a.usdTotal ? fmtUSD(a.usdTotal) : "",
        a.orphanStop ? "start not captured" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `<div class="sa-row">
        <span class="sa-type">${termHtml("subagent", a.agentType || "agent")}</span>
        ${bar}
        <span class="sa-meta muted">${meta}</span>
      </div>`;
    })
    .join("");

  return `<details class="sub" data-exp="${escapeHtml(g.id)}:agents">
    <summary><span class="label">Subagents (${g.subagents.length})${usdNote}</span></summary>
    <div class="sa-list">${lanes}</div>
  </details>`;
}

// ---------- raw events ----------

export function rawEventsHtml(g: PromptGroup): string {
  if (g.rawEvents.length === 0) {
    return "";
  }
  const items = g.rawEvents
    .map((e) => {
      const body = e.json
        ? `<pre class="tape"><code>${highlightJson(e.json)}</code></pre>
           <button class="copy" type="button" data-copy="${escapeHtml(e.eventId)}">Copy JSON</button>`
        : `<p class="muted small">Raw JSON evicted from memory — the full record is in <code>~/.promptconduit/events.jsonl</code>.</p>`;
      const trunc = e.truncated
        ? `<p class="muted small">Truncated at 32&nbsp;KB — full record in <code>~/.promptconduit/events.jsonl</code>.</p>`
        : "";
      return `<details class="raw-ev" data-exp="${escapeHtml(g.id)}:raw:${escapeHtml(e.eventId)}">
        <summary><code>${escapeHtml(e.hookEvent)}</code><span class="muted">${shortTime(e.capturedAt)}</span></summary>
        ${body}${trunc}
      </details>`;
    })
    .join("");
  return `<details class="sub" data-exp="${escapeHtml(g.id)}:rawlist">
    <summary><span class="label">Raw events (${g.rawEvents.length})</span></summary>
    <div class="raw-list">${items}</div>
  </details>`;
}

// ---------- per-request token drill ----------

function requestRow(r: CostEvent): string {
  const cost = r.model_priced ? fmtUSD(r.cost.total) : "unpriced";
  const sig = r.signals
    ? `<span class="muted">${termHtml("cache_hit_rate", "cache hit")} ${pct(r.signals.cache_hit_rate)}</span>`
    : "";
  return `<div class="req-row">
    <span class="req-cost">${cost}</span>
    <span class="muted">${escapeHtml(r.model)}</span>
    <span class="muted">${termHtml("input_tokens", "in")} ${num(r.tokens.input)} · ${termHtml("output_tokens", "out")} ${num(r.tokens.output)} · ${termHtml("cache_read", "cache read")} ${num(r.tokens.cache_read)} · ${termHtml("cache_write", "cache write")} ${num(r.tokens.cache_write)}</span>
    ${sig}
  </div>`;
}

// ---------- one prompt ledger entry ----------

const KIND_TITLES: Record<PromptGroup["kind"], string> = {
  prompt: "",
  uncaptured: "(prompt not captured — cost recorded at generation end)",
  preamble: "(events before the first prompt)",
};

export function promptGroupHtml(g: PromptGroup, maxCost: number, tool: string): string {
  const { usd, anyPriced } = groupCost(g);
  const cost = anyPriced ? fmtUSD(usd) : g.requests.length > 0 ? "unpriced" : "—";
  const widthPct = anyPriced && maxCost > 0 ? Math.max(3, Math.round((usd / maxCost) * 100)) : 0;
  // Geometry via data attributes: the client applies widths through CSSOM,
  // which the strict CSP allows (inline style="" attributes are blocked).
  const bar =
    widthPct > 0
      ? `<div class="bar"><div class="bar-fill" data-w="${widthPct}"></div></div>`
      : "";

  const excerpt = g.promptText
    ? escapeHtml(g.promptText.length > 140 ? `${g.promptText.slice(0, 140)}…` : g.promptText)
    : `<span class="muted">${escapeHtml(KIND_TITLES[g.kind] || "(no prompt text)")}</span>`;

  const badges = [
    modeBadgeHtml(g.permissionMode),
    g.interrupted ? `<span class="chip chip-int">interrupted</span>` : "",
  ]
    .filter(Boolean)
    .join("");

  const metaBits = [
    shortTime(g.startedAt),
    fmtDuration(g.turnDurationMs),
    g.toolCalls.length > 0 ? `${g.toolCalls.length} tool${g.toolCalls.length === 1 ? "" : "s"}` : "",
    g.subagents.length > 0 ? `${g.subagents.length} subagent${g.subagents.length === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const permissions =
    g.permissions.length > 0
      ? `<div class="muted small perms">${g.permissions
          .map(
            (p) =>
              `${escapeHtml(p.decision)}${p.toolName ? `: ${escapeHtml(p.toolName)}` : ""}`,
          )
          .join(" · ")}</div>`
      : "";

  const fullPrompt =
    g.promptText && g.promptText.length > 140
      ? `<details class="sub" data-exp="${escapeHtml(g.id)}:prompt"><summary><span class="label">Full prompt</span></summary><blockquote class="prompt-full">${escapeHtml(g.promptText)}</blockquote></details>`
      : "";

  return `<details class="entry" data-exp="${escapeHtml(g.id)}">
    <summary>
      <div class="entry-head">
        <span class="entry-cost">${cost}</span>
        <span class="entry-excerpt">${excerpt}</span>
        ${badges}
      </div>
      <div class="entry-meta muted">${escapeHtml(metaBits)}</div>
      ${bar}
    </summary>
    <div class="entry-body">
      ${fullPrompt}
      ${g.requests.map(requestRow).join("")}
      ${comparisonHtml(groupModelTotal(g), tool, "this prompt")}
      ${toolCallsHtml(g)}
      ${subagentsHtml(g)}
      ${permissions}
      ${rawEventsHtml(g)}
    </div>
  </details>`;
}

// ---------- session sections ----------

function driversHtml(s: SessionSummary): string {
  const sig = s.signals;
  if (!sig) {
    return "";
  }
  const cards = [
    {
      key: "cache_hit_rate",
      label: "cache hit rate",
      value: pct(sig.cache_hit_rate),
      cls: sig.cache_hit_rate >= 0.6 ? "good" : sig.cache_hit_rate >= 0.3 ? "ok" : "warn",
    },
    {
      key: "fresh_input_share",
      label: "fresh input",
      value: pct(sig.input_token_share),
      cls: sig.input_token_share <= 0.2 ? "good" : sig.input_token_share <= 0.5 ? "ok" : "warn",
    },
    { key: "tier", label: "model tier", value: sig.tier, cls: "ok" },
    { key: "", label: "tool calls", value: num(sig.tool_calls), cls: "ok" },
  ];
  return `<section class="drivers">
    ${cards
      .map(
        (c) => `<div class="metric ${c.cls}">
          <span class="metric-val">${escapeHtml(c.value)}</span>
          <span class="metric-label">${c.key ? termHtml(c.key, c.label) : escapeHtml(c.label)}</span>
        </div>`,
      )
      .join("")}
  </section>`;
}

function byModelHtml(s: SessionSummary): string {
  if (s.by_model.length === 0) {
    return "";
  }
  const rows = s.by_model
    .map(
      (m) => `<tr>
        <td>${escapeHtml(m.model)}${m.model_priced ? "" : ` <span class="chip">${termHtml("model_unpriced", "unpriced")}</span>`}</td>
        <td class="n">${num(m.tokens.input)}</td>
        <td class="n">${num(m.tokens.output)}</td>
        <td class="n">${num(m.tokens.cache_read)}</td>
        <td class="n">${num(m.tokens.cache_write)}</td>
        <td class="n">${m.model_priced ? fmtUSD(m.cost_total) : "—"}</td>
      </tr>`,
    )
    .join("");
  return `<section>
    <h2>By model</h2>
    <table class="models">
      <thead><tr><th>Model</th><th class="n">${termHtml("input_tokens", "Input")}</th><th class="n">${termHtml("output_tokens", "Output")}</th><th class="n">${termHtml("cache_read", "Cache read")}</th><th class="n">${termHtml("cache_write", "Cache write")}</th><th class="n">Cost</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

/** One ledger item per prompt, newest first, with stable ids/revs for diffing. */
export function ledgerItems(s: SessionView): Array<{ id: string; rev: number; html: string }> {
  const groups = [...s.prompts].reverse(); // newest first
  const maxCost = groups.reduce((m, g) => Math.max(m, groupCost(g).usd), 0);
  return groups.map((g) => ({
    id: g.id,
    rev: g.rev,
    html: promptGroupHtml(g, maxCost, s.tool),
  }));
}

function ledgerFooter(s: SessionView): string {
  return s.droppedPrompts > 0
    ? `<p class="muted small">+${s.droppedPrompts} older prompt${s.droppedPrompts === 1 ? "" : "s"} evicted from memory — full history in <code>~/.promptconduit/events.jsonl</code>.</p>`
    : "";
}

export function ledgerHtml(s: SessionView): string {
  const items = ledgerItems(s);
  if (items.length === 0) {
    return "";
  }
  return `<section class="ledger">
    <h2>Cost per prompt</h2>
    <p class="muted small">Each entry is one prompt, newest first — expand for its requests, tool calls, subagents, and raw events.</p>
    <div class="ledger-items">${items.map((i) => i.html).join("")}</div>
    ${ledgerFooter(s)}
  </section>`;
}

function heroHtml(s: SessionView): string {
  const t = s.summary.totals;
  const cost = t.cost_total > 0 ? fmtUSDHero(t.cost_total) : "unpriced";
  const requests = s.summary.by_model.reduce((n) => n, 0);
  void requests;
  return `<header class="hero">
    <p class="kicker">This session would cost</p>
    <p class="hero-cost">${cost}</p>
    <div class="hero-meta">
      ${toolBadge(s.tool)}
      <span class="chip">${escapeHtml(s.summary.source || "")}</span>
      <code class="sid">${escapeHtml(shortKey(s.key))}</code>
      ${s.isActive ? `<span class="chip chip-live">active</span>` : ""}
    </div>
    ${vcsLineHtml(s)}
  </header>`;
}

function tipsHtml(state: CostPanelState): string {
  if (state.tips.length === 0) {
    return "";
  }
  return `<section>
    <h2>Tips for this session</h2>
    ${state.tips
      .map(
        (t) => `<div class="tip-card">
          <strong>${escapeHtml(t.title)}</strong>
          <p class="muted">${escapeHtml(t.detail)}${t.link ? ` <a href="${escapeHtml(t.link.href)}">${escapeHtml(t.link.label)}</a>` : ""}</p>
        </div>`,
      )
      .join("")}
  </section>`;
}

function edgeCasesHtml(state: CostPanelState): string {
  if (state.edgeCases.length === 0) {
    return "";
  }
  return `<section>
    <h2>Worth knowing</h2>
    ${state.edgeCases
      .map(
        (e) => `<div class="tip-card ${e.severity === "warn" ? "warn" : ""}">
          <strong>${escapeHtml(e.title)}</strong>
          <p class="muted">${escapeHtml(e.detail)}</p>
        </div>`,
      )
      .join("")}
  </section>`;
}

function linksHtml(state: CostPanelState): string {
  if (state.links.length === 0) {
    return "";
  }
  return `<section>
    <h2>Learn more</h2>
    <ul class="links">${state.links
      .map(
        (l) =>
          `<li><a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a> <span class="muted">— ${escapeHtml(l.desc)}</span></li>`,
      )
      .join("")}</ul>
  </section>`;
}

function sessionTail(s: SessionView, state: CostPanelState): string {
  const dominant = s.summary.by_model[0];
  return `
    ${comparisonHtml(dominant, s.tool, "this session")}
    ${byModelHtml(s.summary)}
    ${tipsHtml(state)}
    ${edgeCasesHtml(state)}
    ${linksHtml(state)}
  `;
}

function sessionCard(s: SessionView, state: CostPanelState): string {
  const t = s.summary.totals;
  const cost = t.cost_total > 0 ? fmtUSD(t.cost_total) : "unpriced";
  return `<details class="entry session-card" data-exp="sess:${escapeHtml(s.key)}"${s.isActive ? " open" : ""}>
    <summary>
      <div class="entry-head">
        <span class="entry-cost">${cost}</span>
        ${toolBadge(s.tool)}
        <code class="sid">${escapeHtml(shortKey(s.key))}</code>
        ${s.isActive ? `<span class="chip chip-live">active</span>` : ""}
      </div>
      ${vcsLineHtml(s)}
    </summary>
    <div class="entry-body">
      ${driversHtml(s.summary)}
      ${ledgerHtml(s)}
      ${byModelHtml(s.summary)}
    </div>
  </details>`;
}

const FOCUS_NOTES: Record<string, string> = {
  prompted: "Following the session you last prompted.",
  terminal: "Following the focused terminal's Claude Code session.",
  pinned: "Pinned — not following your latest prompt.",
  activity: "Reflects the most recently active conversation.",
};

function toolbarHtml(state: CostPanelState): string {
  return `<nav class="toolbar">
    <span class="focus-note muted">${escapeHtml(FOCUS_NOTES[state.focusSource] ?? "")}</span>
    <span class="toolbar-spacer"></span>
    <button type="button" class="tb" data-cmd="expandAll">Expand all</button>
    <button type="button" class="tb" data-cmd="collapseAll">Collapse all</button>
    <button type="button" class="tb" data-cmd="${state.mode === "session" ? "showAll" : "showSession"}">${state.mode === "session" ? "All sessions" : "Focused session"}</button>
    <button type="button" class="tb" data-cmd="pinSession">Pin…</button>
    <button type="button" class="tb" data-cmd="refresh" title="Reload this panel to pick up an extension update — no window reload">↻ Refresh</button>
  </nav>`;
}

/**
 * Zoned render for efficient live updates. In session mode the client swaps
 * `top`/`rest` wholesale (cheap) and diffs `ledger.items` by id+rev so an
 * expanded raw-JSON block isn't rebuilt on every push. All-sessions and
 * zero-state renders put everything in `top` (full replace).
 */
export interface RenderZones {
  top: string;
  ledger?: { header: string; items: Array<{ id: string; rev: number; html: string }>; footer: string };
  rest: string;
}

export function renderZones(state: CostPanelState): RenderZones {
  if (state.sessions.length === 0) {
    return {
      top: `${toolbarHtml(state)}
      <header class="hero">
        <p class="kicker">AI Session Cost</p>
        <p class="hero-cost muted">—</p>
        <p class="muted">100% local. Run an AI coding session with PromptConduit hooks installed and this report fills in live.</p>
      </header>`,
      rest: "",
    };
  }
  if (state.mode === "session") {
    const s = state.sessions[0];
    return {
      top: `${toolbarHtml(state)}${heroHtml(s)}${driversHtml(s.summary)}`,
      ledger: {
        header: `<h2>Cost per prompt</h2>
          <p class="muted small">Each entry is one prompt, newest first — expand for its requests, tool calls, subagents, and raw events.</p>`,
        items: ledgerItems(s),
        footer: ledgerFooter(s),
      },
      rest: sessionTail(s, state),
    };
  }
  const total = state.sessions.reduce((s, v) => s + v.summary.totals.cost_total, 0);
  return {
    top: `${toolbarHtml(state)}
    <header class="hero">
      <p class="kicker">These ${state.sessions.length} session${state.sessions.length === 1 ? "" : "s"} would cost</p>
      <p class="hero-cost">${total > 0 ? fmtUSDHero(total) : "unpriced"}</p>
      <p class="muted small">Across every tracked conversation on this machine.</p>
    </header>
    <section>
      <h2>By session</h2>
      ${state.sessions.map((s) => sessionCard(s, state)).join("")}
    </section>`,
    rest: `${tipsHtml(state)}${edgeCasesHtml(state)}${linksHtml(state)}`,
  };
}

/** Full body HTML (tests + all-mode full replace). */
export function renderBody(state: CostPanelState): string {
  const z = renderZones(state);
  const ledger = z.ledger
    ? `<section class="ledger">${z.ledger.header}<div class="ledger-items">${z.ledger.items
        .map((i) => i.html)
        .join("")}</div>${z.ledger.footer}</section>`
    : "";
  return `<div id="pc-top">${z.top}</div>${ledger ? `<div id="pc-ledger">${ledger}</div>` : ""}<div id="pc-rest">${z.rest}</div>`;
}
