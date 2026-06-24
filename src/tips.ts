import { CostEvent, SessionSummary, Signals } from "./types";

// A single cost-reduction tip: a one-line action plus the why behind it.
export interface Tip {
  title: string;
  detail: string;
}

function hasUnpriced(session: SessionSummary): boolean {
  return (session.by_model ?? []).some((m) => !m.model_priced);
}

// Fallback cache-hit-rate from session totals, mirroring the CLI formula, for
// when a record predates the `signals` bundle (v1) or omits it.
function cacheHitRateFromTotals(s: SessionSummary): number {
  const t = s.totals;
  const denom = t.cache_read + t.cache_write + t.input;
  return denom > 0 ? t.cache_read / denom : 0;
}

/**
 * buildTips derives actionable cost-reduction tips from a session's signals
 * (with safe fallbacks computed from totals). It returns [] when nothing is
 * actionable yet, so the panel shows tips only when they'd genuinely help.
 * Thresholds are intentionally conservative to avoid noise early in a session.
 */
export function buildTips(
  session: SessionSummary | undefined,
  _lastEvent: CostEvent | undefined,
): Tip[] {
  const tips: Tip[] = [];
  if (!session) {
    return tips;
  }

  const sig: Signals | undefined = session.signals;
  const totals = session.totals;
  const inputSide = totals.input + totals.cache_read + totals.cache_write;
  const cacheHit = sig?.cache_hit_rate ?? cacheHitRateFromTotals(session);
  const missShare = sig?.cache_miss_cost_share ?? 0;

  // 1. Uncached context dominates input (or all of an unpriced session's tokens).
  if (inputSide > 20_000 && cacheHit < 0.4 && (missShare >= 0.5 || totals.cost_total === 0)) {
    const pct = Math.round((1 - cacheHit) * 100);
    tips.push({
      title: "Reuse context to hit the prompt cache",
      detail: `~${pct}% of your input tokens weren't cache hits. Keep one session going and avoid re-pasting large files — cached reads are ~10× cheaper than fresh input.`,
    });
  }

  // 2. Premium-tier model for routine work.
  if (sig?.tier === "premium") {
    tips.push({
      title: "Drop to a cheaper model for routine edits",
      detail:
        "You're on a premium-tier model. Reserve it for hard problems and switch to a standard/economy model for boilerplate and quick edits.",
    });
  }

  // 3. Lots of fresh input each turn.
  const inputShare = sig?.input_token_share ?? (inputSide > 0 ? totals.input / inputSide : 0);
  if (inputSide > 20_000 && inputShare >= 0.6) {
    const pct = Math.round(inputShare * 100);
    tips.push({
      title: "Trim the context you send each turn",
      detail: `${pct}% of input-side tokens were fresh input. Paste only the relevant code and let the cache carry the rest across turns.`,
    });
  }

  // 4. High tool-call volume.
  const toolCalls = session.tools?.total ?? sig?.tool_calls ?? 0;
  if (toolCalls >= 40) {
    tips.push({
      title: "Batch tool calls where you can",
      detail: `${toolCalls} tool calls this session. Grouping related reads/edits into fewer, larger steps cuts round-trips and output tokens.`,
    });
  }

  // 5. Unpriced models present.
  if (hasUnpriced(session)) {
    tips.push({
      title: "Some models are unpriced",
      detail:
        "Models with no rate (e.g. Cursor's composer) show exact tokens but no dollar cost — treat their token counts as the cost signal.",
    });
  }

  return tips;
}
