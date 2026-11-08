// "How you've done this before": compares one prompt with the user's other
// prompts of the same task kind, from whatever the extension has loaded from
// ~/.promptconduit/events.jsonl. Pure; no vscode import.

import type { PromptGroup } from "../promptGroup";
import type { TaskKind } from "./taskKind";

/** One past prompt, reduced to the numbers the comparison needs. */
export interface PromptPoint {
  promptId: string;
  /** First 60 chars of the prompt; stays on this machine. */
  text: string;
  ts: string;
  usd: number;
  roundTrips: number;
  avgContext: number;
  current?: boolean;
}

export interface HistoryView {
  kind: TaskKind;
  /** Past prompts of this kind (excluding the current one). */
  count: number;
  medianUsd: number;
  medianRoundTrips: number;
  medianContext: number;
  cheapest?: PromptPoint;
  /** Past prompts plus the current one, for the cost-per-round-trip scatter. */
  points: PromptPoint[];
  firstTs?: string;
  lastTs?: string;
}

/** Fewer past prompts than this and the comparison isn't shown. */
export const MIN_HISTORY = 3;
const MAX_POINTS = 400;

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Reduce a prompt group to a point; undefined when it has no priced calls. */
export function toPoint(g: PromptGroup): PromptPoint | undefined {
  if (g.kind !== "prompt" || g.requests.length === 0) return undefined;
  const after = new Set(g.afterPromptRequestIds ?? []);
  const calls = g.requests.filter((r) => !after.has(r.request_id));
  if (calls.length === 0) return undefined;
  // Wake-ups after the prompt ended are shown separately, not in its cost.
  const usd = calls.reduce((a, r) => a + r.cost.total, 0);
  const ctx =
    calls.reduce((a, r) => a + r.tokens.input + r.tokens.cache_read + r.tokens.cache_write, 0) /
    calls.length;
  return {
    promptId: g.id,
    text: (g.promptText ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
    ts: g.startedAt ?? calls[0].ts,
    usd,
    roundTrips: calls.length,
    avgContext: ctx,
  };
}

/**
 * Compare `current` with every other prompt of the same kind across all
 * loaded conversations. Undefined when there isn't enough history.
 */
export function compareHistory(
  current: PromptGroup,
  allGroups: Iterable<PromptGroup>,
): HistoryView | undefined {
  const kind = current.taskKind;
  const me = toPoint(current);
  if (!kind || kind === "other" || !me) return undefined;
  const past: PromptPoint[] = [];
  for (const g of allGroups) {
    if (g.id === current.id || g.taskKind !== kind) continue;
    const p = toPoint(g);
    if (p) past.push(p);
  }
  if (past.length < MIN_HISTORY) return undefined;
  past.sort((a, b) => a.ts.localeCompare(b.ts));
  const cheapest = past.reduce((a, p) => (p.usd < a.usd ? p : a));
  const recent = past.slice(-MAX_POINTS);
  return {
    kind,
    count: past.length,
    medianUsd: median(past.map((p) => p.usd)),
    medianRoundTrips: median(past.map((p) => p.roundTrips)),
    medianContext: median(past.map((p) => p.avgContext)),
    cheapest,
    points: [...recent, { ...me, current: true }],
    firstTs: past[0].ts,
    lastTs: past[past.length - 1].ts,
  };
}
