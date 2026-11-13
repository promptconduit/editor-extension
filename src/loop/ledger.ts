// The Loop's data model: one prompt as a sequence of model round-trips, and
// re-pricings of the same steps under other approaches ("what would have made
// this cheaper"). Pure — no vscode import — and mirrored in the CLI
// (internal/loop) and the platform API (app/api/src/loop). Keep field names and
// rules in sync with docs/specs/the-loop.md in the workspace repo.

import type { PromptGroup, PromptToolCall } from "../promptGroup";
import type { CostEvent, Tokens } from "../types";
import { resolvePrice, type ModelPrice } from "../pricing";
import type { TaskKind } from "./taskKind";

export interface LoopTool {
  name: string;
  ok?: boolean;
  durationMs?: number;
  mcpServer?: string;
}

export interface LoopCall {
  requestId: string;
  ts: string;
  model: string;
  tokens: Tokens;
  usd: { input: number; output: number; cache_read: number; cache_write: number; total: number };
  /** What the model read on this call: input + cache_read + cache_write. */
  contextTokens: number;
  /** Tools this call asked for (they run between this call and the next). */
  tools: LoopTool[];
  /** Ran after the prompt's Stop (a background task woke the agent). */
  afterPrompt?: boolean;
}

export interface LoopLedger {
  promptId: string;
  taskKind: TaskKind;
  startedAt?: string;
  endedAt?: string;
  calls: LoopCall[];
  /** USD split: re-reading cached history, writing new context, model output. */
  totals: { usd: number; reread: number; newContext: number; output: number };
  /** Calls inside the prompt (excludes after-prompt wake-ups). */
  roundTrips: number;
  avgContext: number;
  longestGapMs: number;
  /** Index of the call before the longest gap (−1 when < 2 calls). */
  longestGapAfterCall: number;
  cacheTtl: "1h" | "5m" | "unknown";
}

export type AdviceId =
  | "fewer-round-trips"
  | "fresh-session"
  | "fresh-plus-script"
  | "avoid-model-switch"
  | "cache-expiry"
  | "after-prompt-wake";

export interface Advice {
  id: AdviceId;
  /** "option" re-prices the same steps; "note" explains something that already happened. */
  kind: "option" | "note";
  title: string;
  detail: string;
  /** Same steps re-priced (option) or the amount the note is about (note). */
  usdIfApplied: number;
  /** usdIfApplied − actual; negative = saving. 0 for notes. */
  deltaUsd: number;
  /** Public guide at promptconduit.dev/coaching/<slug>. */
  guideSlug?: string;
}

/** How the session started: a fresh session pays this again. */
export interface SessionOpening {
  firstCallUsd: number;
  firstCallContext: number;
}

const FIVE_MIN_MS = 5 * 60 * 1000;
const CAPTURE_SLACK_MS = 1000;
/** Options that save less than this aren't worth a line. */
const MIN_SAVING = 0.02;

function ms(ts: string | undefined): number {
  const v = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(v) ? NaN : v;
}

function ctxOf(t: Tokens): number {
  return t.input + t.cache_read + t.cache_write;
}

export function usd(n: number): string {
  return "$" + n.toFixed(2);
}

export function tokensK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1000) return Math.round(n / 1000) + "K";
  return String(Math.round(n));
}

function toCall(r: CostEvent, after: boolean): LoopCall {
  return {
    requestId: r.request_id,
    ts: r.ts,
    model: r.model,
    tokens: r.tokens,
    usd: {
      input: r.cost.input,
      output: r.cost.output,
      cache_read: r.cost.cache_read,
      cache_write: r.cost.cache_write,
      total: r.cost.total,
    },
    contextTokens: ctxOf(r.tokens),
    tools: [],
    ...(after ? { afterPrompt: true } : {}),
  };
}

/**
 * Attach each tool to the call that asked for it: the latest call that started
 * at or before the tool started (finish time − duration). Tools without
 * timing fall back to the call's own tool-name counts, in order.
 */
function attachTools(calls: LoopCall[], tools: PromptToolCall[], requests: CostEvent[]): void {
  const inPrompt = calls.filter((c) => !c.afterPrompt);
  if (inPrompt.length === 0) return;
  const pending: PromptToolCall[] = [];
  for (const t of tools) {
    const end = ms(t.at);
    if (Number.isNaN(end)) {
      pending.push(t);
      continue;
    }
    // captured_at is whole seconds while call timestamps carry milliseconds,
    // so allow one second of slack.
    const start = end - (t.durationMs ?? 0) + CAPTURE_SLACK_MS;
    let host = inPrompt[0];
    for (const c of inPrompt) {
      if (ms(c.ts) <= start) host = c;
    }
    host.tools.push({ name: t.name, ok: t.ok, durationMs: t.durationMs, mcpServer: t.mcpServer });
  }
  if (pending.length === 0) return;
  // Name-count fallback (older captures without tool timestamps).
  const byReq = new Map(requests.map((r) => [r.request_id, r]));
  for (const c of inPrompt) {
    const names = byReq.get(c.requestId)?.tools?.by_name ?? {};
    for (const [name, count] of Object.entries(names)) {
      for (let i = 0; i < count; i++) {
        const j = pending.findIndex((p) => p.name === name);
        if (j < 0) break;
        const t = pending.splice(j, 1)[0];
        c.tools.push({ name: t.name, ok: t.ok, durationMs: t.durationMs, mcpServer: t.mcpServer });
      }
    }
  }
}

function detectTtl(calls: LoopCall[]): LoopLedger["cacheTtl"] {
  for (const c of calls) {
    if (c.tokens.cache_write <= 0 || c.usd.cache_write <= 0) continue;
    const p = resolvePrice(c.model)?.price;
    if (!p?.cacheWrite1h || !p.cacheWrite5m) continue;
    const rate = c.usd.cache_write / c.tokens.cache_write;
    return Math.abs(rate - p.cacheWrite1h) < Math.abs(rate - p.cacheWrite5m) ? "1h" : "5m";
  }
  return "unknown";
}

/** Build the ledger for one prompt group. Undefined when it has no priced calls. */
export function buildLedger(g: PromptGroup): LoopLedger | undefined {
  if (g.requests.length === 0) return undefined;
  const after = new Set(g.afterPromptRequestIds ?? []);
  const sorted = [...g.requests].sort((a, b) => (ms(a.ts) || 0) - (ms(b.ts) || 0));
  const calls = [
    ...sorted.filter((r) => !after.has(r.request_id)).map((r) => toCall(r, false)),
    ...sorted.filter((r) => after.has(r.request_id)).map((r) => toCall(r, true)),
  ];
  attachTools(calls, g.toolCalls, g.requests);

  const totals = { usd: 0, reread: 0, newContext: 0, output: 0 };
  for (const c of calls) {
    totals.usd += c.usd.total;
    totals.reread += c.usd.cache_read;
    totals.newContext += c.usd.cache_write + c.usd.input;
    totals.output += c.usd.output;
  }
  const inPrompt = calls.filter((c) => !c.afterPrompt);
  let longestGapMs = 0;
  let longestGapAfterCall = -1;
  for (let i = 1; i < inPrompt.length; i++) {
    const gap = ms(inPrompt[i].ts) - ms(inPrompt[i - 1].ts);
    if (gap > longestGapMs) {
      longestGapMs = gap;
      longestGapAfterCall = i - 1;
    }
  }
  const avgContext =
    inPrompt.length > 0 ? inPrompt.reduce((a, c) => a + c.contextTokens, 0) / inPrompt.length : 0;
  return {
    promptId: g.id,
    taskKind: g.taskKind ?? "other",
    startedAt: g.startedAt,
    endedAt: g.endedAt,
    calls,
    totals,
    roundTrips: inPrompt.length,
    avgContext,
    longestGapMs,
    longestGapAfterCall,
    cacheTtl: detectTtl(calls),
  };
}

// ---- re-pricing ----------------------------------------------------------

function newTokens(c: LoopCall): number {
  return c.tokens.cache_write + c.tokens.input + c.tokens.output;
}

/**
 * The same calls in a fresh session: the first call costs what this session's
 * first call cost, later calls re-read the opening context plus whatever the
 * new session has accumulated, and keep their own writes and output.
 */
function repriceFresh(calls: LoopCall[], open: SessionOpening, price: ModelPrice): number {
  const read = price.cacheRead ?? 0;
  let total = 0;
  let grown = 0;
  calls.forEach((c, i) => {
    if (i === 0) {
      total += open.firstCallUsd + c.usd.output;
    } else {
      total += (open.firstCallContext + grown) * read + c.usd.cache_write + c.usd.input + c.usd.output;
    }
    grown += newTokens(c);
  });
  return total;
}

/** The same calls on another model; call 1 re-caches the whole context (1h rate). */
function repriceOnModel(calls: LoopCall[], price: ModelPrice): number {
  const write = price.cacheWrite1h ?? price.cacheWrite5m ?? price.input;
  const read = price.cacheRead ?? price.input;
  return calls.reduce((a, c, i) => {
    const t = c.tokens;
    const io = t.output * price.output;
    return a + (i === 0 ? c.contextTokens * write + io : t.cache_read * read + t.cache_write * write + t.input * price.input + io);
  }, 0);
}

/**
 * Round-trips left after collapsing runs of consecutive one-tool calls (a
 * status check, a lookup, a ToolSearch) into a single call each.
 */
export function collapsedRoundTrips(calls: LoopCall[]): number {
  let kept = 0;
  let inRun = false;
  for (const c of calls) {
    const single = c.tools.length === 1;
    if (single && inRun) continue;
    kept += 1;
    inRun = single;
  }
  return kept;
}

/** A cheaper sibling to test the "just switch models" idea against. */
function siblingModel(model: string): string | undefined {
  if (/opus|fable|mythos/.test(model)) return "claude-sonnet-5";
  if (/sonnet/.test(model)) return "claude-haiku-4-5";
  return undefined;
}

function fmtGap(msVal: number): string {
  const s = Math.round(msVal / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Options (same steps re-priced) and notes for one ledger, cheapest option first. */
export function buildAdvice(ledger: LoopLedger, open?: SessionOpening): Advice[] {
  const calls = ledger.calls.filter((c) => !c.afterPrompt);
  if (calls.length === 0) return [];
  const actual = calls.reduce((a, c) => a + c.usd.total, 0);
  const model = calls[0].model;
  const price = resolvePrice(model)?.price;
  const out: Advice[] = [];
  const option = (a: Omit<Advice, "kind" | "deltaUsd">) =>
    out.push({ ...a, kind: "option", deltaUsd: a.usdIfApplied - actual });

  const kept = collapsedRoundTrips(calls);
  const scripted = (actual / calls.length) * kept;
  if (kept < calls.length && actual - scripted >= MIN_SAVING) {
    option({
      id: "fewer-round-trips",
      title: "Fewer round-trips",
      detail: `${calls.length - kept} of the ${calls.length} round-trips each ran a single tool, back to back. Doing those steps in one command or script gets this down to ${kept} round-trips, and every round-trip skipped saves a full re-read of ~${tokensK(ledger.avgContext)} tokens.`,
      usdIfApplied: scripted,
      guideSlug: "batch-tool-calls",
    });
  }

  if (open && price && ledger.avgContext > open.firstCallContext * 1.5) {
    const fresh = repriceFresh(calls, open, price);
    if (actual - fresh >= MIN_SAVING) {
      option({
        id: "fresh-session",
        title: "Same steps in a fresh session (or a subagent)",
        detail: `A fresh session first pays ${usd(open.firstCallUsd)} to cache its ~${tokensK(open.firstCallContext)} tokens of setup, then each round-trip re-reads ${tokensK(open.firstCallContext)} instead of ${tokensK(ledger.avgContext)}. A subagent works the same way and keeps this conversation intact. Only worth it when the task doesn't need the history.`,
        usdIfApplied: fresh,
        guideSlug: "delegate-with-subagents",
      });
    }
    if (kept < calls.length) {
      const both = repriceFresh(calls.slice(0, kept), open, price);
      if (actual - both >= MIN_SAVING && both > scripted) {
        option({
          id: "fresh-plus-script",
          title: "Fewer round-trips, in a fresh session",
          detail: `Combining both doesn't help here. With only ${kept} round-trips, the ${usd(open.firstCallUsd)} start-up cost of a fresh session never pays back.`,
          usdIfApplied: both,
        });
      }
    }
  }

  const sib = siblingModel(model);
  const sibPrice = sib ? resolvePrice(sib)?.price : undefined;
  if (sib && sibPrice && price && ledger.avgContext > 50_000) {
    const switched = repriceOnModel(calls, sibPrice);
    const sameRead = (sibPrice.cacheRead ?? 0) === (price.cacheRead ?? 0);
    option({
      id: "avoid-model-switch",
      title: `Switch to ${sib} for this part`,
      detail:
        switched > actual
          ? `Costs more, not less. ${sameRead ? `${sib} reads cache at the same rate as ${model}, and ` : ""}switching models means caching all ~${tokensK(calls[0].contextTokens)} tokens again for the new model on the first call.`
          : `Cheaper even after re-caching ~${tokensK(calls[0].contextTokens)} tokens for the new model. Switch at the start of the next session, where the re-cache is smallest.`,
      usdIfApplied: switched,
    });
  }

  if (ledger.longestGapMs > FIVE_MIN_MS && ledger.longestGapAfterCall >= 0 && price) {
    const next = calls[ledger.longestGapAfterCall + 1];
    if (next) {
      if (ledger.cacheTtl === "1h") {
        const avoided = next.contextTokens * (price.cacheWrite5m ?? price.input * 1.25);
        out.push({
          id: "cache-expiry",
          kind: "note",
          title: `${fmtGap(ledger.longestGapMs)} wait, cache kept`,
          detail: `The model waited ${fmtGap(ledger.longestGapMs)} before call #${ledger.longestGapAfterCall + 2}, longer than a standard 5-minute prompt cache. This session caches for 1 hour, so nothing was rewritten. With a 5-minute cache that call would have rewritten ~${tokensK(next.contextTokens)} tokens for about ${usd(avoided)}.`,
          usdIfApplied: avoided,
          deltaUsd: 0,
          guideSlug: "improve-cache-hit-rate",
        });
      } else if (next.usd.cache_write > MIN_SAVING) {
        out.push({
          id: "cache-expiry",
          kind: "note",
          title: `${fmtGap(ledger.longestGapMs)} wait, cache expired`,
          detail: `The cache expired during a ${fmtGap(ledger.longestGapMs)} wait, so call #${ledger.longestGapAfterCall + 2} rewrote ~${tokensK(next.tokens.cache_write)} tokens. Avoid long blocking waits mid-task, or use a 1-hour cache.`,
          usdIfApplied: next.usd.cache_write,
          deltaUsd: 0,
          guideSlug: "improve-cache-hit-rate",
        });
      }
    }
  }

  const wakes = ledger.calls.filter((c) => c.afterPrompt);
  if (wakes.length > 0) {
    const w = wakes.reduce((a, c) => a + c.usd.total, 0);
    out.push({
      id: "after-prompt-wake",
      kind: "note",
      title: "Charged after the prompt finished",
      detail: `${wakes.length === 1 ? "A background task" : `${wakes.length} background tasks`} finished after this prompt ended and woke the agent, which re-read the conversation to report it.`,
      usdIfApplied: w,
      deltaUsd: 0,
    });
  }

  return out.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === "option" ? -1 : 1) : a.kind === "option" ? a.usdIfApplied - b.usdIfApplied : 0,
  );
}
