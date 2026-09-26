// 30-day API-equivalent spend from the local event log. Used only to decide
// whether the cost panel should offer `promptconduit login`. Never uploaded.

import * as fs from "fs";
import { costEventsFrom, parseEnvelopeV2 } from "./envelope";
import { eventsJsonlPath, rotatedEventsPath } from "./visualizer/paths";

export const MONTH_WINDOW_DAYS = 30;
export const MONTH_WINDOW_MS = MONTH_WINDOW_DAYS * 24 * 60 * 60 * 1000;
/** Priced sessions before the login prompt appears. Enough to have seen a real total. */
export const LOGIN_CTA_MIN_SESSIONS = 3;

export interface MonthSpend {
  usd: number;
  sessions: number;
}

const CACHE_MS = 60_000;
let cached: { at: number; spend: MonthSpend } | undefined;

/** Sum priced requests whose timestamp falls in [now - window, now]. */
export function accumulateMonthSpend(
  lines: Iterable<string>,
  now: number,
  windowMs = MONTH_WINDOW_MS,
): MonthSpend {
  const cutoff = now - windowMs;
  const sessions = new Set<string>();
  const seen = new Set<string>();
  let usd = 0;
  for (const line of lines) {
    const env = parseEnvelopeV2(line);
    if (!env) {
      continue;
    }
    for (const ev of costEventsFrom(env)) {
      if (!ev.model_priced || !ev.request_id) {
        continue;
      }
      const ts = Date.parse(ev.ts);
      if (Number.isNaN(ts) || ts < cutoff || ts > now) {
        continue;
      }
      if (seen.has(ev.request_id)) {
        continue;
      }
      seen.add(ev.request_id);
      usd += ev.cost.total;
      if (ev.session_id) {
        sessions.add(ev.session_id);
      }
    }
  }
  return { usd, sessions: sessions.size };
}

async function readLines(filePath: string): Promise<string[]> {
  try {
    const text = await fs.promises.readFile(filePath, "utf8");
    return text.split("\n");
  } catch {
    return [];
  }
}

/** Read the live log and its one rotation. Cached for a minute so panel refreshes don't rescan. */
export async function readMonthSpend(now = Date.now()): Promise<MonthSpend> {
  if (cached && now - cached.at < CACHE_MS && now >= cached.at) {
    return cached.spend;
  }
  const [current, rotated] = await Promise.all([
    readLines(eventsJsonlPath()),
    readLines(rotatedEventsPath()),
  ]);
  const spend = accumulateMonthSpend([...rotated, ...current], now);
  cached = { at: now, spend };
  return spend;
}

/** Test hook: drop the scan cache. */
export function resetMonthSpendCache(): void {
  cached = undefined;
}
