// Session Graph webview renderer: GraphPanelState -> HTML strings.
// Pure (no DOM, no vscode) so every section is unit-testable in plain node —
// and portable: any surface that produces a GraphPanelState can use it.
//
// The tree is a vertical list of graphviz-style boxes: session root, then one
// box per turn (prompt → Stop), each with aggregated tool chips and nested
// subagent boxes. Nesting is expressed in the DOM (`data-node` boxes inside
// `data-parent` containers); connectors.ts draws the elbow wires from those
// positions after each render. All model/user-controlled strings pass through
// escapeHtml.

import type {
  CacheStats,
  CostBreakdown,
  GraphPanelState,
  GraphSessionNode,
  GraphSubagentNode,
  GraphTurnNode,
  PermissionEntry,
  TokenBreakdown,
  ToolStat,
} from "../../src/graphPanel/protocol";
import { escapeHtml } from "../costPanel/jsonHighlight";

// Short, human-friendly session id (keep the distinctive tail).
function shortId(key: string): string {
  return key.length > 12 ? `…${key.slice(-8)}` : key;
}

// Basename of a path without node:path (this runs in the webview bundle).
function basename(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const i = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return i >= 0 ? norm.slice(i + 1) : norm;
}

function fmtUsd(usd: number | undefined): string {
  if (usd === undefined || usd <= 0) return "";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

// Precise USD for the detail panel (cache savings can be small but meaningful).
function fmtUsd4(usd: number | undefined): string {
  if (usd === undefined) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  return `$${usd.toFixed(4)}`;
}

function fmtInt(n: number | undefined): string {
  if (n === undefined) return "—";
  return n.toLocaleString("en-US");
}

function fmtPct(frac: number | undefined): string {
  if (frac === undefined) return "—";
  return `${Math.round(frac * 100)}%`;
}

function fmtDuration(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtAgo(epochMs: number, now: number): string {
  const s = Math.max(0, Math.round((now - epochMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function worktreePill(path: string | undefined): string {
  if (!path) return "";
  return ` <span class="pill worktree" title="${escapeHtml(path)}">⑂ ${escapeHtml(basename(path))}</span>`;
}

function sideStat(cls: string, text: string, title = ""): string {
  if (!text) return "";
  const t = title ? ` title="${escapeHtml(title)}"` : "";
  return `<span class="${cls} mono"${t}>${escapeHtml(text)}</span>`;
}

// ---- toolbar & header ----

function toolbarHtml(state: GraphPanelState): string {
  const options = state.sessions
    .map((s) => {
      const live = s.live ? "● " : "";
      const repo = s.repo ? ` — ${s.repo}${s.branch ? ` @ ${s.branch}` : ""}` : "";
      const sel = s.key === state.selectedKey ? " selected" : "";
      return `<option value="${escapeHtml(s.key)}"${sel}>${escapeHtml(`${live}${s.tool || "session"} ${shortId(s.key)}${repo}`)}</option>`;
    })
    .join("");
  const picker = state.sessions.length
    ? `<label for="picker">session</label>
       <select id="picker" class="picker" data-picker>${options}</select>`
    : "";
  return `<nav class="toolbar">
    ${picker}
    <span class="toolbar-spacer"></span>
    <button type="button" class="tb" data-cmd="refresh" title="Reload this panel to pick up an extension update — no window reload">↻ Refresh</button>
  </nav>`;
}

function headerHtml(s: GraphSessionNode, now: number): string {
  const title = s.repo ? `${s.repo}${s.branch ? ` @ ${s.branch}` : ""}` : s.tool || "session";
  const liveBadge = s.live
    ? `<span class="dot live"></span><span class="live-label on">live</span>`
    : s.ended
      ? `<span class="dot"></span><span class="live-label">ended</span>`
      : `<span class="dot"></span><span class="live-label">idle</span>`;
  const meta: string[] = [];
  if (s.tool) meta.push(escapeHtml(s.tool));
  if (s.model) meta.push(escapeHtml(s.model));
  const turnCount = s.turns.length + s.droppedTurns;
  meta.push(`${turnCount} turn${turnCount === 1 ? "" : "s"}`);
  const usd = fmtUsd(s.usdTotal);
  if (usd) meta.push(`${usd} total`);
  meta.push(escapeHtml(fmtAgo(s.lastActivity, now)));
  return `<h1>${escapeHtml(title)} ${liveBadge}${worktreePill(s.worktreePath)}</h1>
  <div class="header-meta">${meta.map((m) => `<span>${m}</span>`).join("")}</div>`;
}

// ---- nodes ----

function toolChips(t: GraphTurnNode): string {
  if (t.tools.total === 0) return "";
  const chips = t.tools.top.map((c) => {
    const failed = c.failed > 0 ? " failed" : "";
    const label = c.count > 1 ? `${c.name} ×${c.count}` : c.name;
    return `<span class="chip${failed}">${escapeHtml(label)}</span>`;
  });
  const shown = t.tools.top.reduce((n, c) => n + c.count, 0);
  if (t.tools.total > shown) {
    chips.push(`<span class="chip">+${t.tools.total - shown} more</span>`);
  }
  return `<div class="chips">${chips.join("")}</div>`;
}

function subagentHtml(a: GraphSubagentNode, turnId: string, selectedId?: string): string {
  const side = [
    sideStat("dur", fmtDuration(a.durationMs)),
    sideStat("usd", fmtUsd(a.usdTotal)),
    a.model ? sideStat("model", a.model) : "",
  ].join("");
  const id = `a:${turnId}:${a.agentId || a.agentType}`;
  return `<div class="node agent${sel(id, selectedId)}" data-node="${escapeHtml(id)}" data-state="${a.state}">
    <div class="node-row">
      <span class="node-label"><span class="state-dot" data-state="${a.state}"></span> <span class="glyph">◉</span> ${escapeHtml(a.agentType)}${worktreePill(a.worktreeBadge ? a.worktreePath : undefined)}</span>
      <span class="node-side">${side}</span>
    </div>
  </div>`;
}

// " selected" when this node's id is the one the user clicked.
function sel(id: string, selectedId?: string): string {
  return id === selectedId ? " selected" : "";
}

function turnLabel(t: GraphTurnNode): string {
  if (t.promptText) return t.promptText;
  if (t.kind === "preamble") return "(session setup)";
  return "(uncaptured turn)";
}

function turnHtml(t: GraphTurnNode, selectedId?: string): string {
  const tag =
    t.state === "interrupted"
      ? `<span class="turn-tag interrupted">interrupted</span>`
      : t.state === "failed"
        ? `<span class="turn-tag failed">failed</span>`
        : "";
  const side = [tag, sideStat("dur", fmtDuration(t.durationMs)), sideStat("usd", fmtUsd(t.usdTotal))].join("");
  const agents = t.subagents.map((a) => subagentHtml(a, t.id, selectedId)).join("");
  const children = agents
    ? `<div class="children" data-parent="t:${escapeHtml(t.id)}">${agents}</div>`
    : "";
  return `<div class="node turn${sel(`t:${t.id}`, selectedId)}" data-node="t:${escapeHtml(t.id)}" data-state="${t.state}" title="${escapeHtml(t.promptText ?? "")}">
    <div class="node-row">
      <span class="node-label"><span class="state-dot" data-state="${t.state}"></span> <span class="glyph">▶</span> ${escapeHtml(turnLabel(t))}</span>
      <span class="node-side">${side}</span>
    </div>
    ${toolChips(t)}
  </div>
  ${children}`;
}

function treeHtml(s: GraphSessionNode, selectedId?: string): string {
  const rootLabel = s.repo ? `${s.repo}${s.branch ? ` @ ${s.branch}` : ""}` : s.tool || "session";
  const rootSide = [sideStat("usd", fmtUsd(s.usdTotal))].join("");
  const stub =
    s.droppedTurns > 0
      ? `<div class="stub">… ${s.droppedTurns} earlier turn${s.droppedTurns === 1 ? "" : "s"} (full history in <code>~/.promptconduit/events.jsonl</code>)</div>`
      : "";
  const rootState = s.live ? "running" : "completed";
  return `<div id="tree" class="tree">
    <svg class="wires" aria-hidden="true"></svg>
    <div class="node session${sel("session", selectedId)}" data-node="session" data-state="${rootState}">
      <div class="node-row">
        <span class="node-label"><span class="state-dot" data-state="${s.live ? "running" : "completed"}"></span> ${escapeHtml(rootLabel)}${worktreePill(s.worktreePath)}</span>
        <span class="node-side">${rootSide}</span>
      </div>
    </div>
    <div class="children" data-parent="session">
      ${stub}
      ${s.turns.map((t) => turnHtml(t, selectedId)).join("")}
    </div>
  </div>`;
}

// ---- detail panel (click a node to inspect) ----

function kv(label: string, value: string): string {
  if (!value || value === "—") return "";
  return `<div class="kv"><span class="k">${escapeHtml(label)}</span><span class="v">${value}</span></div>`;
}

function dsection(title: string, inner: string): string {
  if (!inner.trim()) return "";
  return `<section class="dsec"><h3>${escapeHtml(title)}</h3>${inner}</section>`;
}

function chips(label: string, values: string[] | undefined): string {
  if (!values || values.length === 0) return "";
  const items = values.map((v) => `<span class="chip">${escapeHtml(v)}</span>`).join("");
  return `<div class="kv col"><span class="k">${escapeHtml(label)}</span><div class="chips">${items}</div></div>`;
}

// input / output / cache read / cache write, with the cache lines highlighted as
// "memory". Each row shows tokens and, when present, the USD for that category.
function tokensBlock(tokens: TokenBreakdown | undefined, cost: CostBreakdown | undefined): string {
  if (!tokens) return "";
  const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  const row = (label: string, tok: number, usd: number | undefined, cls = "") =>
    `<div class="tok-row ${cls}">
       <span class="tok-label">${escapeHtml(label)}</span>
       <span class="tok-count mono">${fmtInt(tok)}</span>
       <span class="tok-usd mono">${cost ? fmtUsd4(usd) : ""}</span>
     </div>`;
  return `<div class="tok-table">
    ${row("Input (fresh)", tokens.input, cost?.input)}
    ${row("Output", tokens.output, cost?.output)}
    ${row("Cache read", tokens.cacheRead, cost?.cacheRead, "mem")}
    ${row("Cache write", tokens.cacheWrite, cost?.cacheWrite, "mem")}
    <div class="tok-row total">
      <span class="tok-label">Total</span>
      <span class="tok-count mono">${fmtInt(total)}</span>
      <span class="tok-usd mono">${cost ? fmtUsd4(cost.total) : ""}</span>
    </div>
  </div>`;
}

// The "memory" story: how much of the context was served from the prompt cache
// and the spend that avoided.
function memoryBlock(cache: CacheStats | undefined): string {
  if (!cache || (cache.readTokens === 0 && cache.writeTokens === 0)) return "";
  const savings =
    cache.savingsUsd !== undefined && cache.savingsUsd > 0
      ? `<div class="savings">≈ ${escapeHtml(fmtUsd4(cache.savingsUsd))} saved by prompt cache</div>`
      : "";
  return `${kv("Cache hit rate", fmtPct(cache.hitRate))}
    ${kv("Read from cache", `${fmtInt(cache.readTokens)} tok`)}
    ${kv("Written to cache", `${fmtInt(cache.writeTokens)} tok`)}
    ${savings}`;
}

function toolsTable(stats: ToolStat[] | undefined): string {
  if (!stats || stats.length === 0) return "";
  const rows = stats
    .map((s) => {
      const name = s.mcpServer
        ? `${s.name} <span class="tool-anno">${escapeHtml(s.mcpServer)}</span>`
        : s.skill
          ? `${s.name} <span class="tool-anno">skill:${escapeHtml(s.skill)}</span>`
          : escapeHtml(s.name);
      const failed = s.failed > 0 ? `<span class="bad">${s.failed}</span>` : "0";
      const time = s.totalMs !== undefined ? fmtDuration(s.totalMs) : "";
      return `<tr><td>${name}</td><td class="num mono">${s.count}</td><td class="num mono">${failed}</td><td class="num mono">${escapeHtml(time)}</td></tr>`;
    })
    .join("");
  return `<table class="dtable">
    <thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">Fail</th><th class="num">Time</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function permissionsBlock(perms: PermissionEntry[] | undefined): string {
  if (!perms || perms.length === 0) return "";
  const rows = perms
    .map((p) => {
      const target = p.toolName ? ` · ${escapeHtml(p.toolName)}` : "";
      const cls = /deni/i.test(p.decision) ? "bad" : "";
      return `<div class="kv"><span class="k ${cls}">${escapeHtml(p.decision)}</span><span class="v">${target}</span></div>`;
    })
    .join("");
  return rows;
}

function detailSessionHtml(s: GraphSessionNode, now: number): string {
  const identity =
    kv("Repo", escapeHtml(s.repo ?? "—")) +
    kv("Branch", escapeHtml(s.branch ?? "—")) +
    kv("Tool", escapeHtml(s.tool || "—")) +
    chips("Models", s.models) +
    kv("Directory", s.cwd ? escapeHtml(s.cwd) : "") +
    kv("Host", s.host ? escapeHtml(s.host) : "") +
    kv("OS", s.os ? escapeHtml(`${s.os}${s.arch ? ` · ${s.arch}` : ""}`) : "") +
    kv("Worktree", s.worktreePath ? escapeHtml(s.worktreePath) : "");
  const timing =
    kv("Status", s.live ? "live" : s.ended ? "ended" : "idle") +
    kv("Started", fmtClock(s.startedAt)) +
    kv("Active", fmtDuration(s.durationMs)) +
    kv("Last event", fmtAgo(s.lastActivity, now)) +
    kv("Turns", fmtInt(s.turns.length + s.droppedTurns));
  return `<div class="detail-title">${escapeHtml(sessionTitle(s))}</div>
    ${dsection("Session", identity)}
    ${dsection("Timing", timing)}
    ${dsection("Cost", costSection(s.usdTotal, s.cost))}
    ${dsection("Tokens", tokensBlock(s.tokens, s.cost))}
    ${dsection("Memory (prompt cache)", memoryBlock(s.cache))}
    ${dsection("Tools", toolsTable(s.toolStats))}
    ${chipsSection("MCP servers", s.mcpServers)}
    ${chipsSection("Skills", s.skills)}`;
}

function detailTurnHtml(t: GraphTurnNode, now: number): string {
  const meta =
    kv("State", stateLabel(t.state)) +
    kv("Mode", t.permissionMode ? escapeHtml(t.permissionMode) : "") +
    kv("Started", fmtClock(t.startedAt)) +
    kv("Duration", fmtDuration(t.durationMs)) +
    chips("Models", t.models) +
    kv("Requests", t.requests !== undefined ? fmtInt(t.requests) : "") +
    kv("Prompt size", t.promptChars !== undefined ? `${fmtInt(t.promptChars)} chars · ${fmtInt(t.promptWords)} words` : "") +
    kv("Attachments", t.hasAttachments ? "yes" : "");
  const prompt = t.promptFull
    ? `<div class="prompt-box">${escapeHtml(t.promptFull)}</div>`
    : "";
  const subs =
    t.subagents.length > 0
      ? t.subagents
          .map(
            (a) =>
              `<div class="kv"><span class="k">${escapeHtml(a.agentType)}</span><span class="v mono">${escapeHtml(
                [fmtDuration(a.durationMs), fmtUsd(a.usdTotal)].filter(Boolean).join(" · "),
              )}</span></div>`,
          )
          .join("")
      : "";
  return `<div class="detail-title">▶ ${escapeHtml(turnLabel(t))}</div>
    ${prompt ? dsection("Prompt", prompt) : ""}
    ${dsection("Turn", meta)}
    ${dsection("Cost", costSection(t.usdTotal, t.cost))}
    ${dsection("Tokens", tokensBlock(t.tokens, t.cost))}
    ${dsection("Memory (prompt cache)", memoryBlock(t.cache))}
    ${dsection("Tools", toolsTable(t.toolStats))}
    ${chipsSection("MCP servers", t.mcpServers)}
    ${chipsSection("Skills", t.skills)}
    ${dsection(`Subagents (${t.subagents.length})`, subs)}
    ${dsection("Permissions", permissionsBlock(t.permissions))}`;
}

function detailSubagentHtml(a: GraphSubagentNode): string {
  const meta =
    kv("Type", escapeHtml(a.agentType)) +
    kv("State", stateLabel(a.state)) +
    kv("Model", a.model ? escapeHtml(a.model) : "") +
    kv("Duration", fmtDuration(a.durationMs)) +
    kv("Requests", a.requests !== undefined ? fmtInt(a.requests) : "") +
    kv("Ran alongside", a.concurrent !== undefined && a.concurrent > 1 ? `${a.concurrent} agents` : "") +
    kv("Worktree", a.worktreeBadge && a.worktreePath ? escapeHtml(a.worktreePath) : "") +
    kv("Agent id", `<span class="mono small">${escapeHtml(a.agentId)}</span>`) +
    (a.orphanStop ? kv("Note", "start not captured (duration estimated)") : "");
  return `<div class="detail-title">◉ ${escapeHtml(a.agentType)}</div>
    ${dsection("Subagent", meta)}
    ${dsection("Cost", kv("Total", fmtUsd4(a.usdTotal)))}
    ${dsection("Tokens", tokensBlock(a.tokens, undefined))}
    ${dsection("Memory (prompt cache)", memoryBlock(a.cache))}`;
}

// Cost section: Total (includes subagents), the lead-model breakdown, and a
// reconciling "Subagents" line so the parts add up to the total.
function costSection(usdTotal: number | undefined, c: CostBreakdown | undefined): string {
  const total = kv("Total", fmtUsd4(usdTotal));
  if (!c) return total;
  const subagents = (usdTotal ?? c.total) - c.total;
  return (
    total +
    kv("Input", fmtUsd4(c.input)) +
    kv("Output", fmtUsd4(c.output)) +
    kv("Cache read", fmtUsd4(c.cacheRead)) +
    kv("Cache write", fmtUsd4(c.cacheWrite)) +
    (subagents > 0.0001 ? kv("Subagents", fmtUsd4(subagents)) : "")
  );
}

function chipsSection(title: string, values: string[] | undefined): string {
  if (!values || values.length === 0) return "";
  return dsection(title, `<div class="chips">${values.map((v) => `<span class="chip">${escapeHtml(v)}</span>`).join("")}</div>`);
}

function stateLabel(state: string): string {
  return `<span class="state-dot" data-state="${escapeHtml(state)}"></span> ${escapeHtml(state)}`;
}

function sessionTitle(s: GraphSessionNode): string {
  return s.repo ? `${s.repo}${s.branch ? ` @ ${s.branch}` : ""}` : s.tool || "session";
}

// Local HH:MM:SS from an ISO timestamp; "—" when absent/unparseable.
function fmtClock(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

// Look up the node the user selected (by its data-node id) without parsing the
// composite ids (turn ids can contain ":"), so matching stays robust.
function detailHtml(state: GraphPanelState, now: number, selectedId?: string): string {
  const s = state.session;
  const hint = `<div class="detail-hint">Click any node — the session, a turn, or a subagent — to inspect its full detail: prompt, tokens, cost, cache/memory savings, every tool call.</div>`;
  if (!s || !selectedId) return hint;
  if (selectedId === "session") return detailSessionHtml(s, now);
  for (const t of s.turns) {
    if (`t:${t.id}` === selectedId) return detailTurnHtml(t, now);
    for (const a of t.subagents) {
      if (`a:${t.id}:${a.agentId || a.agentType}` === selectedId) return detailSubagentHtml(a);
    }
  }
  return hint; // selected node aged out of the buffer
}

// ---- empty states ----

function emptyHtml(state: GraphPanelState): string {
  if (state.logDisabled) {
    return `<div class="empty muted">
    <p>The local event log is <strong>disabled</strong> (<code>PROMPTCONDUIT_EVENT_LOG=0</code>).</p>
    <p>Unset that variable and restart your AI tool to start streaming events.</p>
  </div>`;
  }
  return `<div class="empty muted">
    <p>No sessions yet. Run an AI coding session (Claude Code or a Cursor agent) with the
    <code>promptconduit</code> CLI hooks installed and it will appear here, growing live —
    prompts, tools, subagents, worktrees.</p>
    <p>Waiting on <code>~/.promptconduit/events.jsonl</code>…</p>
  </div>`;
}

/**
 * Full body HTML for one state push. `now` is injectable for tests;
 * `selectedId` is the data-node id of the clicked node (owned by the client),
 * which drives both the highlighted node and the detail panel.
 */
export function renderGraphBody(
  state: GraphPanelState,
  now: number = Date.now(),
  selectedId?: string,
): string {
  const body = state.session
    ? `<div class="layout">
        <div class="graph-col">${headerHtml(state.session, now)}${treeHtml(state.session, selectedId)}</div>
        <div class="divider" data-divider role="separator" aria-orientation="vertical" title="Drag to resize"></div>
        <aside class="detail-col">${detailHtml(state, now, selectedId)}</aside>
      </div>`
    : emptyHtml(state);
  return `${toolbarHtml(state)}
  ${body}
  <footer>
    Read straight from the local log on your machine. None of your data is sent anywhere.
  </footer>`;
}
