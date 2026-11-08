// The Loop: pure LoopPanelState → HTML. No DOM access here, so it unit-tests
// in node and can be reused by a plain web page. main.ts mounts the result,
// wires events and runs the replay animation. Inline style attributes are
// blocked by the webview CSP, so all geometry is SVG attributes and all color
// is classes.

import type { Advice, LoopCall, LoopLedger } from "../../src/loop/ledger";
import type { HistoryView } from "../../src/loop/history";
import type { LoopPanelState, LoopSession } from "../../src/loopPanel/protocol";
import { TASK_KIND_LABEL } from "../../src/loop/taskKind";

// ---- formatting -----------------------------------------------------------

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
const usd = (n: number, d = 2) => "$" + n.toFixed(d);
export function k(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1000) return Math.round(n / 1000) + "K";
  return String(Math.round(n));
}
const int = (n: number) => Math.round(n).toLocaleString("en-US");
const ms = (ts?: string) => (ts ? Date.parse(ts) : NaN);
function clock(ts?: string): string {
  const t = ms(ts);
  return Number.isNaN(t)
    ? ""
    : new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
function when(ts?: string): string {
  const t = ms(ts);
  return Number.isNaN(t)
    ? ""
    : new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function dur(msVal?: number): string {
  if (msVal === undefined) return "";
  if (msVal >= 60_000) {
    const s = Math.round(msVal / 1000);
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  }
  return msVal >= 1000 ? `${Math.round(msVal / 1000)}s` : `${Math.round(msVal)}ms`;
}
const shortTool = (n: string) => n.replace(/^mcp__([^_]+(?:-[^_]+)*)__/, "$1: ");
const attr = (o: Record<string, string | number>) =>
  Object.entries(o)
    .map(([a, v]) => `${a}="${typeof v === "number" ? +v.toFixed(2) : esc(v)}"`)
    .join(" ");

// ---- top-level ---------------------------------------------------------------

export function renderApp(s: LoopPanelState): string {
  if (!s.session) return renderEmpty(s);
  if (!s.ledger) return renderHeader(s, s.session) + renderNoCalls(s) + renderAgentHint(s);
  return [
    renderHeader(s, s.session),
    renderLoop(s.ledger, s.advice, s.subagents),
    renderWhatIf(s.ledger, s.advice),
    renderHistory(s.ledger, s.history),
    renderTeam(s),
    renderGrowth(s.session, s.selectedPromptId),
    renderSync(s),
    renderAgentHint(s),
  ].join("");
}

function renderEmpty(s: LoopPanelState): string {
  return `<div class="empty">
    <div class="eyebrow">PromptConduit · The Loop</div>
    <h1>Run a prompt in Claude Code or Cursor to see where its money goes.</h1>
    <p class="muted">Each prompt becomes a series of round-trips to the model. The Loop shows how much conversation each one re-read, which tools ran in between, what each step cost, and what would have been cheaper. Everything is read from your local event log.</p>
    ${renderSetup(s)}
    ${renderSync(s)}
    ${renderAgentHint(s)}
  </div>`;
}

/** First-run steps: the extension only reads what the CLI records. */
function renderSetup(s: LoopPanelState): string {
  const st = s.setup;
  if (!st) return "";
  const cmd = (text: string, runCmd: string) =>
    `<div class="cmdline"><code>${esc(text)}</code><span><button type="button" data-cmd="${runCmd}">Run in terminal</button> <button type="button" data-copy="${esc(text)}">Copy</button></span></div>`;
  const install = st.installCommand
    ? `<li>Install the free, open-source CLI:${cmd(st.installCommand, "installCli")}</li>`
    : `<li>Install the free, open-source CLI. See the <a data-href="${esc(st.docsUrl)}">installation guide</a>.</li>`;
  const intro =
    st.step === "install-cli"
      ? "The Loop shows what the PromptConduit CLI records on your machine. The CLI isn't installed yet."
      : "The PromptConduit CLI is installed but hasn't recorded an AI session yet.";
  return `<section class="card setup"><div><h2>Set up cost tracking</h2><p>${intro}</p>
    <ol>${st.step === "install-cli" ? install : ""}<li>Connect Claude Code or Cursor:${cmd(st.initCommand, "runInit")}</li><li>Start an AI session. It appears here as it runs.</li></ol>
    <p>No account needed: everything stays on this machine. <a data-href="${esc(st.docsUrl)}">Setup guide →</a></p></div></section>`;
}

/** "Ask your agent": the same data through PromptConduit's MCP server. */
function renderAgentHint(s: LoopPanelState): string {
  const h = s.agentHint;
  if (!h) return "";
  const label = esc(h.label);
  const body = h.registered
    ? `<p>PromptConduit's MCP server is registered with ${label}, so you can also ask in chat:</p><ul class="questions">${h.questions
        .map((q) => `<li><q>${esc(q)}</q> <button type="button" data-copy="${esc(q)}">Copy</button></li>`)
        .join("")}</ul>`
    : `<p>Register PromptConduit's MCP server with ${label} and your agent can answer <q>${esc(h.questions[0] ?? "")}</q> itself, from the same local data.${
        h.otherRegistered.length ? ` Already registered with ${esc(h.otherRegistered.join(", "))}.` : ""
      }</p>`;
  const actions = [
    h.registered ? "" : `<button type="button" class="primary" data-cmd="registerMcp">Register with ${label}</button>`,
    h.signedIn ? `<button type="button" data-cmd="inviteTeammate">Invite a teammate</button>` : "",
    `<button type="button" data-cmd="dismissAgentHint">${h.registered ? "Hide" : "Not now"}</button>`,
  ].join(" ");
  return `<section class="card agent"><div><h2>Ask your agent</h2>${body}</div><span>${actions}</span></section>`;
}

function renderNoCalls(s: LoopPanelState): string {
  const live = s.session?.prompts.find((p) => p.id === s.selectedPromptId)?.live;
  return `<section><p class="muted">${
    live
      ? "This prompt is still running. Its round-trips appear here as soon as the turn ends."
      : "No priced model calls were captured for this prompt."
  }</p></section>`;
}

// ---- header -------------------------------------------------------------------

/** Why this session is shown (the status bar's focus source). */
const FOCUS_NOTE: Partial<Record<LoopPanelState["focusSource"], string>> = {
  terminal: "following the focused terminal",
  "cursor-tab": "following the selected Cursor agent tab",
  pinned: "pinned",
};

function renderHeader(s: LoopPanelState, sess: LoopSession): string {
  const L = s.ledger;
  const options = sess.prompts
    .map(
      (p) =>
        `<option value="${esc(p.id)}"${p.id === s.selectedPromptId ? " selected" : ""}>${esc(
          `${usd(p.usd)} · ${p.text || "(no text)"}`.slice(0, 90),
        )}${p.live ? " · running" : ""}</option>`,
    )
    .join("");
  const picker = `<div class="bar">
    <select id="pick" aria-label="Prompt">${options}</select>
    <button id="latest" type="button"${s.followLatest ? " disabled" : ""}>${s.followLatest ? "Following latest" : "Follow latest"}</button>
    <span class="grow"></span>
    <span class="meta"><span>${esc(sess.tool)}${sess.where ? " · " + esc(sess.where) : ""}</span><span>session <b>${usd(sess.totalUsd)}</b></span>${FOCUS_NOTE[s.focusSource] ? `<span class="focus">${FOCUS_NOTE[s.focusSource]}</span>` : ""}</span>
  </div>`;
  const open = `<header data-session="${esc(sess.key)}">`;
  if (!L) {
    return `${open}<div class="eyebrow">The Loop</div>${picker}<span class="prompt">${esc(s.promptText ?? "")}</span></header>`;
  }
  const inPrompt = L.calls.filter((c) => !c.afterPrompt);
  const tot = inPrompt.reduce((a, c) => a + c.usd.total, 0);
  const reread = inPrompt.reduce((a, c) => a + c.usd.cache_read, 0);
  const fresh = tot - reread;
  const nTools = inPrompt.reduce((a, c) => a + c.tools.length, 0);
  const newTok = inPrompt.reduce((a, c) => a + c.tokens.cache_write + c.tokens.input + c.tokens.output, 0);
  const share = tot > 0 ? Math.round((reread / tot) * 100) : 0;
  const model = inPrompt[0]?.model ?? "";
  const live = sess.prompts.find((p) => p.id === s.selectedPromptId)?.live;
  const headline =
    share >= 50
      ? `${usd(tot)} for this prompt. ${share}% of it was re-reading the conversation.`
      : `${usd(tot)} for this prompt. Most of it was new work, not re-reading.`;
  const lede =
    inPrompt.length <= 1
      ? `One round-trip to the model, reading ~${k(L.avgContext)} tokens.`
      : `The model made ${inPrompt.length} round-trips. On each one it read the <span class="r">same ~${k(L.avgContext)} tokens of history</span> again, which cost <b class="num">${usd(reread)}</b> in total. Everything new, including tool output and <span class="o">what the model wrote</span>, came to ${int(newTok)} tokens and <b class="num">${usd(fresh)}</b>. Tools cost nothing themselves. Each one costs a round-trip.`;
  return `${open}
    <div class="eyebrow">The Loop ·${esc(TASK_KIND_LABEL[L.taskKind])} task${live ? ' · <span class="live">● running</span>' : ""}</div>
    ${picker}
    <div class="meta"><span class="prompt" title="${esc(s.promptText ?? "")}">${esc((s.promptText ?? "").slice(0, 140))}</span><span>${esc(when(L.startedAt))}</span><span><b>${inPrompt.length}</b> round-trips</span><span><b>${nTools}</b> tool runs</span><span>${esc(model)}</span></div>
    <h1>${esc(headline)}</h1>
    <p class="lede">${lede}</p>
  </header>`;
}

// ---- the loop chart -------------------------------------------------------------

export interface LoopGeometry {
  width: number;
  height: number;
}

/** The loop strip as SVG. Columns carry data-* so main.ts can animate them. */
export function loopSvg(L: LoopLedger): { svg: string; geo: LoopGeometry } {
  const calls = L.calls;
  const nIn = calls.filter((c) => !c.afterPrompt).length;
  const colW = 34, gap = 62, bigGap = 100, wakeGap = 96, left = 56, top = 34, H = 180;
  const costTop = top + H + 86, costH = 64;
  const maxCtx = Math.max(100_000, ...calls.map((c) => c.contextTokens)) * 1.08;
  const maxUsd = Math.max(0.01, ...calls.map((c) => c.usd.total)) * 1.25;
  const pos: number[] = [];
  let x = left + 18;
  calls.forEach((c, i) => {
    pos.push(x);
    const g = i === nIn - 1 && nIn < calls.length ? wakeGap : c.tools.some((t) => (t.durationMs ?? 0) > 60_000) ? bigGap : gap;
    x += colW + g;
  });
  const W = Math.max(640, (pos[pos.length - 1] ?? left) + colW + 24);
  const VH = costTop + costH + 30;
  const yC = (v: number) => top + H - (v / maxCtx) * H;
  const yU = (v: number) => costTop + costH - (v / maxUsd) * costH;
  const out: string[] = [];
  const ticks = niceTicks(maxCtx, 4);
  for (const v of ticks) {
    out.push(`<line ${attr({ x1: left, x2: W - 8, y1: yC(v), y2: yC(v) })} class="s-line"/>`);
    out.push(`<text ${attr({ x: left - 6, y: yC(v) + 4, "text-anchor": "end", "font-size": 10 })}>${v ? k(v) : "0"}</text>`);
  }
  out.push(`<text ${attr({ x: 4, y: top - 16, "font-size": 10 })}>tokens read</text>`);
  for (const v of niceTicks(maxUsd, 3)) {
    out.push(`<line ${attr({ x1: left, x2: W - 8, y1: yU(v), y2: yU(v) })} class="s-line"${v ? ' stroke-dasharray="2 4"' : ""}/>`);
    out.push(`<text ${attr({ x: left - 6, y: yU(v) + 4, "text-anchor": "end", "font-size": 10 })}>${usd(v)}</text>`);
  }
  out.push(`<text ${attr({ x: 4, y: costTop - 12, "font-size": 10 })}>cost per call</text>`);
  if (nIn < calls.length) {
    const dx = pos[nIn] - wakeGap / 2;
    out.push(`<line ${attr({ x1: dx, x2: dx, y1: top - 20, y2: VH - 8 })} class="s-faint" stroke-dasharray="3 4"/>`);
    out.push(`<text ${attr({ x: dx + 6, y: top - 18, "font-size": 10 })} class="warn">after the prompt ended</text>`);
  }
  calls.forEach((c, i) => {
    const x0 = pos[i];
    const yR = yC(c.tokens.cache_read);
    const yTop = yC(c.contextTokens);
    const wH = Math.max(2, yR - yTop);
    const oH = Math.max(2, Math.min(24, (c.tokens.output / maxCtx) * H * 6));
    const base = top + H;
    const tip = callTip(c, i);
    out.push(`<g class="col" data-i="${i}" data-tip="${esc(tip)}">`);
    out.push(`<rect class="f-read rd" ${attr({ x: x0, y: yR, width: colW, height: base - yR, rx: 2 })} data-y="${yR.toFixed(1)}" data-base="${base}"/>`);
    out.push(`<rect class="f-write ex" ${attr({ x: x0, y: yR - wH, width: colW, height: wH })}/>`);
    out.push(`<rect class="f-out ex" ${attr({ x: x0 + colW * 0.2, y: yR - wH - oH - 1, width: colW * 0.6, height: oH, rx: 1 })}/>`);
    out.push(`<rect class="f-accent scan" ${attr({ x: x0, y: base, width: colW, height: 0 })} opacity="0.35"/>`);
    out.push(`<text ${attr({ x: x0 + colW / 2, y: yR - wH - oH - 7, "text-anchor": "middle", "font-size": 10 })}${c.afterPrompt ? ' class="warn"' : ""}>${k(c.contextTokens)}</text>`);
    out.push(`<text ${attr({ x: x0 + colW / 2, y: base + 14, "text-anchor": "middle", "font-size": 10 })}>#${i + 1}</text>`);
    out.push(`<text ${attr({ x: x0 + colW / 2, y: base + 27, "text-anchor": "middle", "font-size": 9 })}>${clock(c.ts)}</text>`);
    let yb = costTop + costH;
    const parts: [number, string][] = [
      [c.usd.cache_read, "f-read"],
      [c.usd.cache_write + c.usd.input, "f-write"],
      [c.usd.output, "f-out"],
    ];
    for (const [v, cls] of parts) {
      if (v <= 0) continue;
      const h = (v / maxUsd) * costH;
      yb -= h;
      out.push(`<rect class="${cls} ex" ${attr({ x: x0, y: yb, width: colW, height: h })}/>`);
    }
    out.push(`<text ${attr({ x: x0 + colW / 2, y: yb - 5, "text-anchor": "middle", "font-size": 10.5 })} class="fg b">${usd(c.usd.total)}</text>`);
    out.push(`<rect class="f-none" ${attr({ x: x0 - 4, y: top - 22, width: colW + 8, height: VH - top + 10 })}/>`);
    out.push(`</g>`);
    // tools between this call and the next
    const gx = x0 + colW + 7;
    const gw = (pos[i + 1] ?? W) - gx - 7;
    c.tools.slice(0, 3).forEach((t, j) => {
      const ty = top + 34 + j * 54;
      const long = (t.durationMs ?? 0) > 60_000;
      const name = shortTool(t.name);
      const max = Math.max(6, Math.floor(gw / 6.4));
      out.push(`<g class="tool" data-tip="${esc(`${t.name}\nran ${dur(t.durationMs) || "—"} · costs $0 itself\nIts output joins the history every later call re-reads.`)}">`);
      out.push(`<rect ${attr({ x: gx, y: ty, width: gw, height: 40, rx: 4 })} class="f-chip ${long ? "s-warn" : "s-line"}"/>`);
      out.push(`<text ${attr({ x: gx + 6, y: ty + 15, "font-size": 10 })} class="fg">${esc(name.length > max ? name.slice(0, max - 1) + "…" : name)}</text>`);
      out.push(`<text ${attr({ x: gx + 6, y: ty + 30, "font-size": 9.5 })}${long ? ' class="warn"' : ""}>${esc(dur(t.durationMs) || "—")}${t.ok === false ? " · failed" : ""}</text>`);
      out.push(`</g>`);
    });
    if (c.tools.length > 3) {
      out.push(`<text ${attr({ x: gx + 4, y: top + 34 + 3 * 54 + 4, "font-size": 9.5 })}>+${c.tools.length - 3} more</text>`);
    }
    if (c.afterPrompt) {
      out.push(`<text ${attr({ x: x0 + colW + 8, y: top + 48, "font-size": 10 })} class="warn">background</text>`);
      out.push(`<text ${attr({ x: x0 + colW + 8, y: top + 61, "font-size": 10 })} class="warn">task woke</text>`);
      out.push(`<text ${attr({ x: x0 + colW + 8, y: top + 74, "font-size": 10 })} class="warn">the agent</text>`);
    }
  });
  return {
    svg: `<svg id="loop" viewBox="0 0 ${W} ${VH}" width="${W}" height="${VH}" role="img" aria-label="Model round-trips for this prompt">${out.join("")}</svg>`,
    geo: { width: W, height: VH },
  };
}

function callTip(c: LoopCall, i: number): string {
  return [
    `Call #${i + 1} · ${usd(c.usd.total, 3)}${c.afterPrompt ? " · after the prompt ended" : ""}`,
    `re-read ${int(c.tokens.cache_read)} tok · ${usd(c.usd.cache_read, 3)}`,
    `new context ${int(c.tokens.cache_write + c.tokens.input)} tok · ${usd(c.usd.cache_write + c.usd.input, 3)}`,
    `model wrote ${int(c.tokens.output)} tok · ${usd(c.usd.output, 3)}`,
  ].join("\n");
}

function niceTicks(max: number, n: number): number[] {
  const raw = max / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

function renderLoop(L: LoopLedger, advice: Advice[], subs?: LoopPanelState["subagents"]): string {
  const { svg } = loopSvg(L);
  const inPrompt = L.calls.filter((c) => !c.afterPrompt);
  const reread = inPrompt.reduce((a, c) => a + c.usd.cache_read, 0);
  const notes: string[] = [];
  if (subs && subs.count > 0) {
    // Subagents run in their own context; their cost isn't in the columns above.
    const amount = subs.unpricedRequests > 0 ? (subs.usd > 0 ? `${usd(subs.usd)}+` : "unpriced") : usd(subs.usd);
    notes.push(
      `<div class="note"><span class="k">${amount}</span><p><strong>${subs.count} subagent${subs.count === 1 ? "" : "s"}, not in the columns above.</strong> Each ran in its own fresh context, which is why delegating can be cheaper than re-reading this conversation.${
        subs.unpricedRequests > 0 ? ` ${subs.unpricedRequests} of their requests used a model without a known price, so the real cost is higher.` : ""
      }</p></div>`,
    );
  }
  if (inPrompt.length > 1) {
    notes.push(
      `<div class="note reread"><span class="k">${usd(reread)}</span><p><strong>Re-reading ~${k(L.avgContext)} tokens, ${inPrompt.length} times.</strong> About <strong>${usd(reread / inPrompt.length, 3)}</strong> per round-trip, whatever the step does. A status check costs the same as writing code.</p></div>`,
    );
  }
  for (const a of advice.filter((x) => x.kind === "note")) {
    const cls = a.id === "after-prompt-wake" || a.title.includes("expired") ? "warn" : "good";
    notes.push(
      `<div class="note ${cls}"><span class="k">${usd(a.usdIfApplied)}</span><p><strong>${esc(a.title)}.</strong> ${esc(a.detail)}${guide(a)}</p></div>`,
    );
  }
  return `<section aria-labelledby="h-loop">
    <div class="sec-head"><h2 id="h-loop">The loop</h2>
      <div class="legend"><span><i class="sw read"></i>history re-read from cache</span><span><i class="sw write"></i>new context written to cache</span><span><i class="sw out"></i>what the model wrote</span></div></div>
    <p class="muted">Each column is one round-trip to the model, as tall as the conversation it had to read. The tools it ran sit between columns. Each column's cost is shown underneath. Hover for detail.</p>
    <div class="stage"><div class="controls"><button id="replay" type="button">▶ Replay</button><span class="meter">running total<b id="meter">${usd(inPrompt.reduce((a, c) => a + c.usd.total, 0))}</b></span></div>
      <div class="scroll">${svg}</div></div>
    ${notes.length ? `<div class="notes">${notes.join("")}</div>` : ""}
  </section>`;
}

function guide(a: Advice & { guideUrl?: string }): string {
  return a.guideUrl ? ` <a data-href="${esc(a.guideUrl)}">Guide →</a>` : "";
}

// ---- what would have made this cheaper -----------------------------------------

function renderWhatIf(L: LoopLedger, advice: (Advice & { guideUrl?: string })[]): string {
  const options = advice.filter((a) => a.kind === "option");
  if (options.length === 0) return "";
  const actual = L.calls.filter((c) => !c.afterPrompt).reduce((a, c) => a + c.usd.total, 0);
  const rows = [
    ...options.map((a) => ({ a, v: a.usdIfApplied })),
    { a: undefined, v: actual },
  ].sort((x, y) => x.v - y.v);
  const max = Math.max(...rows.map((r) => r.v));
  const html = rows
    .map(({ a, v }) => {
      const w = max > 0 ? (v / max) * 1000 : 0;
      const bar = `<svg viewBox="0 0 1000 7" preserveAspectRatio="none"><rect class="f-chip" width="1000" height="7" rx="3"/><rect class="${a ? (a.deltaUsd < 0 ? "f-accent" : "f-warn") : "f-read"}" width="${w.toFixed(1)}" height="7" rx="3"/></svg>`;
      if (!a) {
        return `<div class="wi base"><div class="lab">As it ran<small>${L.roundTrips} round-trips at ~${k(L.avgContext)} context.</small></div><div class="amt">${usd(v)}</div>${bar}</div>`;
      }
      const d = a.deltaUsd;
      return `<div class="wi"><div class="lab">${esc(a.title)}<span class="delta ${d < 0 ? "save" : "more"}">${d < 0 ? "−" : "+"}${usd(Math.abs(d))}</span><small>${esc(a.detail)}${guide(a)}</small></div><div class="amt">${usd(v)}</div>${bar}</div>`;
    })
    .join("");
  return `<section aria-labelledby="h-diff">
    <div class="sec-head"><h2 id="h-diff">What would have made this cheaper</h2><span class="eyebrow">same steps, re-priced</span></div>
    <p class="muted">Each line re-prices this prompt's real token counts under a different approach. Cheapest first.</p>
    <div class="whatif">${html}</div>
  </section>`;
}

// ---- history --------------------------------------------------------------------

function renderHistory(L: LoopLedger, h?: HistoryView): string {
  const label = TASK_KIND_LABEL[L.taskKind];
  if (!h) {
    return `<section aria-labelledby="h-hist"><div class="sec-head"><h2 id="h-hist">How you've done this before</h2></div>
      <p class="muted">${
        L.taskKind === "other"
          ? "This prompt didn't match a task type, so there's nothing to compare it with."
          : `Not enough past ${esc(label)} tasks yet. Once you've run three, this compares cost, round-trips and context with your usual.`
      }</p></section>`;
  }
  const me = h.points.find((p) => p.current)!;
  const ratio = h.medianUsd > 0 ? me.usd / h.medianUsd : 0;
  const ctxRatio = h.medianContext > 0 ? me.avgContext / h.medianContext : 0;
  const verdict =
    ratio >= 1.5
      ? `This run cost <b class="num">${ratio.toFixed(1)}×</b> your usual${ctxRatio >= 1.5 ? `, mostly because its context was ${ctxRatio.toFixed(1)}× bigger` : me.roundTrips > h.medianRoundTrips * 1.5 ? `, mostly because it took ${me.roundTrips} round-trips instead of ${h.medianRoundTrips}` : ""}.`
      : ratio <= 0.67 && ratio > 0
        ? `This run cost <b class="num">${ratio.toFixed(1)}×</b> your usual. Cheaper than most.`
        : `This run cost about the same as your usual.`;
  const c = h.cheapest;
  const stats = [
    [usd(me.usd), usd(h.medianUsd), "cost · this run vs your median"],
    [String(me.roundTrips), String(h.medianRoundTrips), "round-trips · this vs median"],
    [k(me.avgContext), k(h.medianContext), "context per round-trip · this vs median"],
    ...(c ? [[usd(c.usd), `${c.roundTrips} call${c.roundTrips === 1 ? "" : "s"} · ${k(c.avgContext)}`, `your cheapest: “${esc(c.text.slice(0, 28))}”, ${esc(when(c.ts))}`]] : []),
  ]
    .map(([a, b, l]) => `<div class="stat"><span class="v">${a}<span>${b}</span></span><span class="l">${l}</span></div>`)
    .join("");
  return `<section aria-labelledby="h-hist">
    <div class="sec-head"><h2 id="h-hist">How you've done this before</h2><span class="eyebrow">${h.count} past ${esc(label)} tasks</span></div>
    <p class="muted">Your earlier ${esc(label)} prompts, from your local event log. ${verdict} The price of a round-trip tracks the size of the conversation almost exactly.</p>
    <div class="stats">${stats}</div>
    <div class="stage"><div class="scroll">${scatterSvg(h)}</div></div>
  </section>`;
}

function scatterSvg(h: HistoryView): string {
  const W = 760, H = 230, l = 56, r = 18, t = 16, b = 36;
  const per = h.points.map((p) => p.usd / Math.max(1, p.roundTrips));
  const maxX = Math.max(...h.points.map((p) => p.avgContext)) * 1.1 || 1;
  const maxY = Math.max(...per) * 1.15 || 0.01;
  const X = (v: number) => l + (v / maxX) * (W - l - r);
  const Y = (v: number) => t + (H - t - b) * (1 - v / maxY);
  const out: string[] = [];
  for (const v of niceTicks(maxY, 4)) {
    out.push(`<line ${attr({ x1: l, x2: W - r, y1: Y(v), y2: Y(v) })} class="s-line"/>`);
    out.push(`<text ${attr({ x: l - 6, y: Y(v) + 4, "text-anchor": "end", "font-size": 10 })}>${usd(v)}</text>`);
  }
  for (const v of niceTicks(maxX, 4)) {
    out.push(`<text ${attr({ x: X(v), y: H - 18, "text-anchor": "middle", "font-size": 10 })}>${v ? k(v) : "0"}</text>`);
  }
  out.push(`<text ${attr({ x: W - r, y: H - 3, "text-anchor": "end", "font-size": 10 })}>context per round-trip →</text>`);
  out.push(`<text ${attr({ x: l, y: t - 4, "font-size": 10 })}>cost per round-trip</text>`);
  h.points
    .slice()
    .sort((a, b2) => Number(!!a.current) - Number(!!b2.current))
    .forEach((p) => {
      const cx = X(p.avgContext);
      const cy = Y(p.usd / Math.max(1, p.roundTrips));
      const rr = 3 + Math.sqrt(p.roundTrips) * 1.4;
      const tip = `${p.text || "(no text)"}\n${when(p.ts)}\n${usd(p.usd)} · ${p.roundTrips} round-trips · ${k(p.avgContext)} context`;
      out.push(
        `<circle ${attr({ cx, cy, r: rr })} class="${p.current ? "f-accent" : "f-read"}" data-tip="${esc(tip)}"${p.current ? ' stroke="currentColor"' : ""}/>`,
      );
      if (p.current) out.push(`<text ${attr({ x: cx + rr + 5, y: cy + 4, "font-size": 11 })} class="fg b">this run</text>`);
    });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Cost per round-trip against context size">${out.join("")}</svg>`;
}

// ---- team -----------------------------------------------------------------------

function renderTeam(s: LoopPanelState): string {
  const kind = esc(TASK_KIND_LABEL[s.ledger?.taskKind ?? "other"]);
  const body = s.signedIn
    ? `<p>See how your teammates run ${kind} tasks: cost, round-trips and context per person, and the habits that keep them cheap. Tasks are grouped by type, so prompt text never leaves anyone's machine.</p><span><a data-href="${esc(s.teamUrl)}">Open team comparison →</a> <button type="button" data-cmd="inviteTeammate">Invite a teammate</button></span>`
    : `<p>Compare ${kind} tasks with your teammates' runs, grouped by task type so prompt text never leaves anyone's machine. Sign in with <code>promptconduit login</code>. Free for up to 3 people.</p><span><button type="button" class="primary" data-cmd="login">Sign in</button> <a data-href="${esc(s.teamUrl)}">Learn more →</a></span>`;
  return `<section aria-labelledby="h-team">
    <div class="sec-head"><h2 id="h-team">How your team does it</h2></div>
    <div class="card">${body}</div>
  </section>`;
}

// ---- session growth -------------------------------------------------------------

function renderGrowth(sess: LoopSession, selected?: string): string {
  const g = sess.growth;
  if (g.length < 2) return "";
  const W = 960, H = 220, l = 56, r = 14, t = 20, b = 34;
  const n = g.length;
  const maxC = Math.max(...g.map((p) => p[1])) * 1.1;
  const X = (i: number) => l + (i / (n - 1)) * (W - l - r);
  const Y = (v: number) => t + (H - t - b) * (1 - v / maxC);
  const out: string[] = [];
  for (const v of niceTicks(maxC, 4)) {
    out.push(`<line ${attr({ x1: l, x2: W - r, y1: Y(v), y2: Y(v) })} class="s-line"/>`);
    out.push(`<text ${attr({ x: l - 6, y: Y(v) + 4, "text-anchor": "end", "font-size": 10 })}>${v ? k(v) : "0"}</text>`);
  }
  let lastDay = "";
  let lastX = -99;
  g.forEach((p, i) => {
    const d = new Date(p[0]).toLocaleDateString([], { month: "short", day: "numeric" });
    if (d !== lastDay) {
      lastDay = d;
      out.push(`<line ${attr({ x1: X(i), x2: X(i), y1: t, y2: H - b })} class="s-line" stroke-dasharray="2 3"/>`);
      const lx = Math.max(X(i) + 4, lastX + 46);
      out.push(`<text ${attr({ x: lx, y: H - b + 15, "font-size": 10 })}>${esc(d)}</text>`);
      lastX = lx;
    }
  });
  const pts = g.map((p, i) => `${X(i).toFixed(1)} ${Y(p[1]).toFixed(1)}`);
  out.push(`<path d="M${X(0)} ${Y(0)} L${pts.join(" L")} L${X(n - 1)} ${Y(0)} Z" class="f-read" opacity="0.6"/>`);
  for (let i = 1; i < n; i++) {
    if (g[i][1] < g[i - 1][1] * 0.6 && g[i - 1][1] > 50_000) {
      out.push(`<circle ${attr({ cx: X(i), cy: Y(g[i][1]), r: 4 })} class="f-accent"/>`);
      out.push(`<text ${attr({ x: X(i) + 7, y: Y(g[i][1]) + 15, "font-size": 10 })} class="fg">${k(g[i - 1][1])} → ${k(g[i][1])} (compacted or cleared)</text>`);
    }
  }
  // highlight the selected prompt's calls
  const mark = sess.promptMarks.findIndex(([, id]) => id === selected);
  if (mark >= 0) {
    const from = Date.parse(sess.promptMarks[mark][0]);
    const to = mark + 1 < sess.promptMarks.length ? Date.parse(sess.promptMarks[mark + 1][0]) : Infinity;
    const idx = g.map((p, i) => [Date.parse(p[0]), i] as const).filter(([ts]) => ts >= from && ts < to).map(([, i]) => i);
    if (idx.length) {
      const x0 = X(idx[0]) - 2, x1 = X(idx[idx.length - 1]) + 2;
      out.push(`<rect ${attr({ x: x0, y: t, width: Math.max(4, x1 - x0), height: H - t - b })} class="f-accent" opacity="0.2"/>`);
      out.push(`<text ${attr({ x: x0 - 5, y: t + 10, "text-anchor": "end", "font-size": 10 })} class="fg">this prompt →</text>`);
    }
  }
  out.push(`<rect id="growth-hit" ${attr({ x: l, y: t, width: W - l - r, height: H - t - b })} class="f-none" data-n="${n}" data-l="${l}" data-w="${W - l - r}"/>`);
  const T = g.reduce((a, p) => a + p[2], 0);
  const Rd = g.reduce((a, p) => a + p[3], 0);
  const Wr = g.reduce((a, p) => a + p[4], 0);
  const Ou = g.reduce((a, p) => a + p[5], 0);
  const pct = (v: number) => (T > 0 ? Math.round((v / T) * 100) : 0);
  const split = `<svg viewBox="0 0 1000 12" preserveAspectRatio="none"><rect class="f-read" x="0" width="${((Rd / T) * 1000).toFixed(1)}" height="12"/><rect class="f-write" x="${((Rd / T) * 1000).toFixed(1)}" width="${((Wr / T) * 1000).toFixed(1)}" height="12"/><rect class="f-out" x="${(((Rd + Wr) / T) * 1000).toFixed(1)}" width="${((Ou / T) * 1000).toFixed(1)}" height="12"/></svg>`;
  return `<section aria-labelledby="h-sess">
    <div class="sec-head"><h2 id="h-sess">How this session got to ${k(g[n - 1][1])} tokens</h2><span class="eyebrow">${n} calls · ${usd(T)}</span></div>
    <p class="muted">Context size on every model call in this session. Everything you add stays in the history, and every later call reads it again.</p>
    <div class="stage"><div class="scroll"><svg id="growth" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Context size across the session">${out.join("")}</svg></div></div>
    <div class="split">${split}</div>
    <div class="splitlab"><span>re-reading history <b>${usd(Rd)}</b> (${pct(Rd)}%)</span><span>writing new context <b>${usd(Wr)}</b> (${pct(Wr)}%)</span><span>model output <b>${usd(Ou)}</b> (${pct(Ou)}%)</span></div>
  </section>`;
}

function renderSync(s: LoopPanelState): string {
  const o = s.syncOffer;
  if (!o) return "";
  return `<div class="card"><p>You've run <b class="num">${usd(o.usd)}</b> of AI coding across ${o.sessions} sessions in the last ${o.windowDays} days. Sign in to keep this history across machines and compare with your team.</p><span><button class="primary" data-cmd="login" type="button">Sign in</button> <button data-cmd="dismissLogin" type="button">Not now</button></span></div>`;
}
