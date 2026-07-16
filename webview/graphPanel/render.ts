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
  GraphPanelState,
  GraphSessionNode,
  GraphSubagentNode,
  GraphTurnNode,
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

function subagentHtml(a: GraphSubagentNode, turnId: string): string {
  const side = [
    sideStat("dur", fmtDuration(a.durationMs)),
    sideStat("usd", fmtUsd(a.usdTotal)),
    a.model ? sideStat("model", a.model) : "",
  ].join("");
  return `<div class="node agent" data-node="a:${escapeHtml(turnId)}:${escapeHtml(a.agentId || a.agentType)}" data-state="${a.state}">
    <div class="node-row">
      <span class="node-label"><span class="state-dot" data-state="${a.state}"></span> <span class="glyph">◉</span> ${escapeHtml(a.agentType)}${worktreePill(a.worktreeBadge ? a.worktreePath : undefined)}</span>
      <span class="node-side">${side}</span>
    </div>
  </div>`;
}

function turnLabel(t: GraphTurnNode): string {
  if (t.promptText) return t.promptText;
  if (t.kind === "preamble") return "(session setup)";
  return "(uncaptured turn)";
}

function turnHtml(t: GraphTurnNode): string {
  const tag =
    t.state === "interrupted"
      ? `<span class="turn-tag interrupted">interrupted</span>`
      : t.state === "failed"
        ? `<span class="turn-tag failed">failed</span>`
        : "";
  const side = [tag, sideStat("dur", fmtDuration(t.durationMs)), sideStat("usd", fmtUsd(t.usdTotal))].join("");
  const agents = t.subagents.map((a) => subagentHtml(a, t.id)).join("");
  const children = agents
    ? `<div class="children" data-parent="t:${escapeHtml(t.id)}">${agents}</div>`
    : "";
  return `<div class="node turn" data-node="t:${escapeHtml(t.id)}" data-state="${t.state}" title="${escapeHtml(t.promptText ?? "")}">
    <div class="node-row">
      <span class="node-label"><span class="state-dot" data-state="${t.state}"></span> <span class="glyph">▶</span> ${escapeHtml(turnLabel(t))}</span>
      <span class="node-side">${side}</span>
    </div>
    ${toolChips(t)}
  </div>
  ${children}`;
}

function treeHtml(s: GraphSessionNode): string {
  const rootLabel = s.repo ? `${s.repo}${s.branch ? ` @ ${s.branch}` : ""}` : s.tool || "session";
  const rootSide = [sideStat("usd", fmtUsd(s.usdTotal))].join("");
  const stub =
    s.droppedTurns > 0
      ? `<div class="stub">… ${s.droppedTurns} earlier turn${s.droppedTurns === 1 ? "" : "s"} (full history in <code>~/.promptconduit/events.jsonl</code>)</div>`
      : "";
  const rootState = s.live ? "running" : "completed";
  return `<div id="tree" class="tree">
    <svg class="wires" aria-hidden="true"></svg>
    <div class="node session" data-node="session" data-state="${rootState}">
      <div class="node-row">
        <span class="node-label"><span class="state-dot" data-state="${s.live ? "running" : "completed"}"></span> ${escapeHtml(rootLabel)}${worktreePill(s.worktreePath)}</span>
        <span class="node-side">${rootSide}</span>
      </div>
    </div>
    <div class="children" data-parent="session">
      ${stub}
      ${s.turns.map(turnHtml).join("")}
    </div>
  </div>`;
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

/** Full body HTML for one state push. `now` is injectable for tests. */
export function renderGraphBody(state: GraphPanelState, now: number = Date.now()): string {
  const body = state.session
    ? `${headerHtml(state.session, now)}${treeHtml(state.session)}`
    : emptyHtml(state);
  return `${toolbarHtml(state)}
  ${body}
  <footer>
    Read straight from the local log on your machine. None of your data is sent anywhere.
  </footer>`;
}
