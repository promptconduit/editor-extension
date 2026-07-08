// Model cost comparison: reprice a session's actual token counts at other
// models' published rates. Pure module — no vscode imports.
//
// This is a RATE comparison, not a capability comparison: it assumes the
// identical token counts, which a different model would not produce. Surface
// COMPARISON_CAVEAT anywhere these numbers are shown.

import { COMPARISON_MODELS, ModelPrice, resolvePrice } from "../pricing";
import type { ModelTotal } from "../types";

export interface ModelComparison {
  model: string;
  altUsd: number;
  deltaUsd: number;
  deltaPct: number;
  cheaper: boolean;
  derivedCacheRates: boolean;
}

export const COMPARISON_CAVEAT =
  "Assumes the identical token counts you actually used — a different model would likely take different turns, tokens, and cache behavior. Treat this as a rate comparison, not a capability comparison.";

// Cursor's Composer models publish no cache rates at all (see the pricing
// table comment); the CLI prices their cache tokens at 0 and we mirror that
// rather than inventing rates Cursor never published. For any OTHER model
// whose cache rates are missing/zero while its input rate is priced, we
// derive them from Anthropic's documented multipliers (read = 0.1x input,
// 5m write = 1.25x input) and flag derivedCacheRates so the UI can say so.
export function cacheRatesFor(key: string, price: ModelPrice): {
  cacheRead: number;
  cacheWrite5m: number;
  derived: boolean;
} {
  const cacheRead = price.cacheRead ?? 0;
  const cacheWrite5m = price.cacheWrite5m ?? 0;
  const missing = (cacheRead === 0 || cacheWrite5m === 0) && price.input > 0;
  if (!missing) {
    return { cacheRead, cacheWrite5m, derived: false };
  }
  if (key.startsWith("composer-")) {
    // Genuinely priced at 0 upstream — keep 0, not "derived".
    return { cacheRead, cacheWrite5m, derived: false };
  }
  return {
    cacheRead: 0.1 * price.input,
    cacheWrite5m: 1.25 * price.input,
    derived: true,
  };
}

// compareModels reprices `actual`'s token counts at each comparison model's
// rates. The folded cache_write total is priced at the 5-minute rate — the
// same fold the CLI applies when a transcript lacks the 5m/1h TTL split — so
// alt costs stay comparable to `actual.cost_total`.
export function compareModels(
  actual: ModelTotal,
  tool: string,
): ModelComparison[] | { unpriced: true } {
  const resolved = resolvePrice(actual.model);
  if (!resolved || !actual.model_priced) {
    return { unpriced: true };
  }

  const candidates =
    tool === "cursor" ? COMPARISON_MODELS.cursor : COMPARISON_MODELS.claudeCode;
  const t = actual.tokens;

  const out: ModelComparison[] = [];
  for (const model of candidates) {
    const alt = resolvePrice(model);
    if (!alt) {
      continue; // model missing from the table
    }
    if (alt.key === resolved.key) {
      continue; // don't compare the actual model against itself
    }
    const rates = cacheRatesFor(alt.key, alt.price);
    const altUsd =
      t.input * alt.price.input +
      t.output * alt.price.output +
      t.cache_read * rates.cacheRead +
      t.cache_write * rates.cacheWrite5m;
    const deltaUsd = altUsd - actual.cost_total;
    const deltaPct = actual.cost_total > 0 ? deltaUsd / actual.cost_total : 0;
    out.push({
      model,
      altUsd,
      deltaUsd,
      deltaPct,
      cheaper: deltaUsd < 0,
      derivedCacheRates: rates.derived,
    });
  }

  out.sort((a, b) => a.altUsd - b.altUsd); // cheapest first
  return out;
}
