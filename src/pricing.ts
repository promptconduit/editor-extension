// MIRRORED across repos — keep in sync with cli/internal/cost/pricing_data.json and pricing.go modelAliases.
//
// Per-token USD rates copied verbatim from the CLI's bundled pricing snapshot
// (LiteLLM-compatible shape, plus the CLI's added 1-hour cache-write rate).
// Resolution logic mirrors cli/internal/cost/pricing.go ResolvePrice exactly:
// exact key → alias map (then exact) → progressively strip trailing
// dash-delimited segments of the ORIGINAL model string. No case folding —
// the Go code does none.
//
// The parity test (test/unit/pricing.test.ts) asserts this table matches the
// CLI JSON byte-for-byte when the cli repo is checked out alongside.

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

// Field mapping from cli/internal/cost/pricing_data.json:
//   input        ← input_cost_per_token
//   output       ← output_cost_per_token
//   cacheRead    ← cache_read_input_token_cost
//   cacheWrite5m ← cache_creation_input_token_cost      (5-minute TTL, 1.25x input)
//   cacheWrite1h ← cache_creation_input_token_cost_1h   (1-hour TTL, 2x input)
/** Date stamped on the embedded snapshot. A published card older than this is ignored. */
export const BUNDLED_CARD_UPDATED = "2026-09-25";

let rateCardOverlay: Record<string, ModelPrice> | undefined;

/**
 * Replace bundled rows with a published PromptConduit card for this webview.
 * Pass undefined to use the bundled table only. The extension host reads the
 * file; this module stays free of filesystem access so the webview can import it.
 */
export function applyRateCard(card: Record<string, ModelPrice> | undefined): void {
  rateCardOverlay = card && Object.keys(card).length > 0 ? card : undefined;
}

function pricingTable(): Record<string, ModelPrice> {
  if (!rateCardOverlay) {
    return PRICING;
  }
  return { ...PRICING, ...rateCardOverlay };
}

export const PRICING: Record<string, ModelPrice> = {
  "claude-fable-5": {
    input: 0.00001,
    output: 0.00005,
    cacheRead: 0.000001,
    cacheWrite5m: 0.0000125,
    cacheWrite1h: 0.00002,
  },
  "claude-fable-5-1": {
    input: 0.00001,
    output: 0.00005,
    cacheRead: 0.00000025,
    cacheWrite5m: 0.0000125,
    cacheWrite1h: 0.00002,
  },
  "claude-mythos-5": {
    input: 0.00001,
    output: 0.00005,
    cacheRead: 0.000001,
    cacheWrite5m: 0.0000125,
    cacheWrite1h: 0.00002,
  },
  "claude-mythos-5-1": {
    input: 0.00001,
    output: 0.00005,
    cacheRead: 0.00000025,
    cacheWrite5m: 0.0000125,
    cacheWrite1h: 0.00002,
  },
  "claude-opus-4-8": {
    input: 0.000005,
    output: 0.000025,
    cacheRead: 0.0000005,
    cacheWrite5m: 0.00000625,
    cacheWrite1h: 0.00001,
  },
  "claude-opus-4-7": {
    input: 0.000005,
    output: 0.000025,
    cacheRead: 0.0000005,
    cacheWrite5m: 0.00000625,
    cacheWrite1h: 0.00001,
  },
  "claude-opus-4-6": {
    input: 0.000005,
    output: 0.000025,
    cacheRead: 0.0000005,
    cacheWrite5m: 0.00000625,
    cacheWrite1h: 0.00001,
  },
  "claude-opus-4-5": {
    input: 0.000005,
    output: 0.000025,
    cacheRead: 0.0000005,
    cacheWrite5m: 0.00000625,
    cacheWrite1h: 0.00001,
  },
  "claude-opus-4-1": {
    input: 0.000015,
    output: 0.000075,
    cacheRead: 0.0000015,
    cacheWrite5m: 0.00001875,
    cacheWrite1h: 0.00003,
  },
  "claude-opus-4-0": {
    input: 0.000015,
    output: 0.000075,
    cacheRead: 0.0000015,
    cacheWrite5m: 0.00001875,
    cacheWrite1h: 0.00003,
  },
  "claude-sonnet-5": {
    input: 0.000002,
    output: 0.00001,
    cacheRead: 0.0000002,
    cacheWrite5m: 0.0000025,
    cacheWrite1h: 0.000004,
  },
  "claude-opus-5": {
    input: 0.000005,
    output: 0.000025,
    cacheRead: 0.0000005,
    cacheWrite5m: 0.00000625,
    cacheWrite1h: 0.00001,
  },
  "claude-opus-5-5": {
    input: 0.000004,
    output: 0.00002,
    cacheRead: 0.0000002,
    cacheWrite5m: 0.000005,
    cacheWrite1h: 0.000008,
  },
  "claude-opus-5-fast": {
    input: 0.00001,
    output: 0.00005,
    cacheRead: 0.000001,
    cacheWrite5m: 0.0000125,
    cacheWrite1h: 0.00002,
  },
  "claude-opus-4-8-fast": {
    input: 0.00001,
    output: 0.00005,
    cacheRead: 0.000001,
    cacheWrite5m: 0.0000125,
    cacheWrite1h: 0.00002,
  },
  "claude-sonnet-4-6": {
    input: 0.000003,
    output: 0.000015,
    cacheRead: 0.0000003,
    cacheWrite5m: 0.00000375,
    cacheWrite1h: 0.000006,
  },
  "claude-sonnet-4-5": {
    input: 0.000003,
    output: 0.000015,
    cacheRead: 0.0000003,
    cacheWrite5m: 0.00000375,
    cacheWrite1h: 0.000006,
  },
  "claude-sonnet-4-0": {
    input: 0.000003,
    output: 0.000015,
    cacheRead: 0.0000003,
    cacheWrite5m: 0.00000375,
    cacheWrite1h: 0.000006,
  },
  "claude-haiku-4-5": {
    input: 0.000001,
    output: 0.000005,
    cacheRead: 0.0000001,
    cacheWrite5m: 0.00000125,
    cacheWrite1h: 0.000002,
  },
  "claude-3-5-haiku": {
    input: 0.0000008,
    output: 0.000004,
    cacheRead: 0.00000008,
    cacheWrite5m: 0.000001,
    cacheWrite1h: 0.0000016,
  },
  "gemini-3.5-flash": {
    input: 0.0000015,
    output: 0.000009,
    cacheRead: 0.00000015,
  },
  "gemini-3.6-flash": {
    input: 0.00000075,
    output: 0.00000375,
    cacheRead: 0.000000075,
  },
  "gemini-3.7-flash": {
    input: 0.00000075,
    output: 0.00000375,
    cacheRead: 0.000000075,
  },
  "gemini-3.8-flash": {
    input: 0.00000075,
    output: 0.00000375,
    cacheRead: 0.000000075,
  },
  "glm-5.2": {
    input: 0.0000014,
    output: 0.0000044,
    cacheRead: 0.00000026,
  },
  "gpt-6-sol": {
    input: 0.000002,
    output: 0.00001,
    cacheRead: 0.0000002,
    cacheWrite5m: 0.0000025,
  },
  "gpt-6-luna": {
    input: 0.0000001,
    output: 0.0000005,
    cacheRead: 0.00000001,
    cacheWrite5m: 0.000000125,
  },
  "gpt-5.3-codex": {
    input: 0.00000175,
    output: 0.000014,
    cacheRead: 0.000000175,
  },
  "gpt-5.6-sol": {
    input: 0.000004,
    output: 0.00002,
    cacheRead: 0.0000004,
    cacheWrite5m: 0.000005,
  },
  "gpt-5.6-terra": {
    input: 0.000002,
    output: 0.000012,
    cacheRead: 0.0000002,
    cacheWrite5m: 0.0000025,
  },
  "gpt-5.6-luna": {
    input: 0.0000002,
    output: 0.0000012,
    cacheRead: 0.00000002,
    cacheWrite5m: 0.00000025,
  },
  "gpt-5.5": {
    input: 0.000005,
    output: 0.00003,
    cacheRead: 0.0000005,
  },
  "gpt-5.4": {
    input: 0.0000025,
    output: 0.000015,
    cacheRead: 0.00000025,
  },
  "gemini-2.5-flash": {
    input: 0.0000003,
    output: 0.0000025,
    cacheRead: 0.00000003,
  },
  "gemini-3-flash": {
    input: 0.0000005,
    output: 0.000003,
    cacheRead: 0.00000005,
  },
  "gemini-3-pro": {
    input: 0.000002,
    output: 0.000012,
    cacheRead: 0.0000002,
  },
  "gemini-3.1-pro": {
    input: 0.000002,
    output: 0.000012,
    cacheRead: 0.0000002,
  },
  "kimi-k2.7-code": {
    input: 0.00000095,
    output: 0.000004,
    cacheRead: 0.00000019,
  },
  "kimi-k3": {
    input: 0.000003,
    output: 0.000015,
    cacheRead: 0.0000003,
  },
  "muse-spark-1.3": {
    input: 0.00000125,
    output: 0.00000425,
    cacheRead: 0.00000015,
  },
  "grok-build-0.1": {
    input: 0.000001,
    output: 0.000002,
    cacheRead: 0.0000002,
  },
  // Cursor first-party rates from cursor.com/docs/models-and-pricing (2026-09-25).
  // Composer/Grok publish cache-read only. The exact "-fast" key must exist so
  // suffix-trim doesn't land on the cheaper standard rate; Grok fast slugs are
  // aliased below. Short hook slugs (grok-4.6) retry as cursor-grok-4.6 in
  // resolvePrice.
  "cursor-grok-4.7-500k-fast": {
    input: 0.000006,
    output: 0.000018,
    cacheRead: 0.0000015,
  },
  "cursor-grok-4.7-500k": {
    input: 0.000004,
    output: 0.000012,
    cacheRead: 0.000001,
  },
  "cursor-grok-4.7-fast": {
    input: 0.000004,
    output: 0.000012,
    cacheRead: 0.000001,
  },
  "cursor-grok-4.7": {
    input: 0.000002,
    output: 0.000006,
    cacheRead: 0.0000005,
  },
  "cursor-grok-4.6-fast": {
    input: 0.000004,
    output: 0.000012,
    cacheRead: 0.000001,
  },
  "cursor-grok-4.6": {
    input: 0.000002,
    output: 0.000006,
    cacheRead: 0.0000005,
  },
  "cursor-grok-4.5-fast": {
    input: 0.000004,
    output: 0.000018,
    cacheRead: 0.000001,
  },
  "cursor-grok-4.5": {
    input: 0.000002,
    output: 0.000006,
    cacheRead: 0.0000005,
  },
  "composer-2.5-fast": {
    input: 0.000003,
    output: 0.000015,
    cacheRead: 0.0000005,
  },
  "composer-2.5": {
    input: 0.0000005,
    output: 0.0000025,
    cacheRead: 0.0000002,
  },
  // Retired Cursor model; rates from cursor.com/docs/models/cursor-composer-1.
  "cursor-composer-1": {
    input: 0.00000125,
    output: 0.00001,
    cacheRead: 0.000000125,
  },
};

// Mirrors pricing.go modelAliases. Kept small on purpose — resolvePrice also
// does suffix-stripping, so this only needs the genuinely irregular cases.
export const MODEL_ALIASES: Record<string, string> = {
  "claude-3-5-haiku-20241022": "claude-3-5-haiku",
  "claude-3-5-haiku-latest": "claude-3-5-haiku",
  "claude-sonnet-4": "claude-sonnet-4-6",
  "claude-sonnet-4-5": "claude-sonnet-4-5",
  "claude-opus-4": "claude-opus-4-6",
  "claude-opus-4-8": "claude-opus-4-8",
  "claude-haiku-4-5": "claude-haiku-4-5",
  "composer-1": "cursor-composer-1",
  "claude-4.5-sonnet": "claude-sonnet-4-5",
  "claude-4.5-opus": "claude-opus-4-5",
  "claude-fable-5.1": "claude-fable-5-1",
  "claude-mythos-5.1": "claude-mythos-5-1",
  "claude-opus-5.5": "claude-opus-5-5",
  "cursor-grok-4.7-500k-high-fast": "cursor-grok-4.7-500k-fast",
  "cursor-grok-4.7-high-fast": "cursor-grok-4.7-fast",
  "cursor-grok-4.6-high-fast": "cursor-grok-4.6-fast",
  "cursor-grok-4.5-high-fast": "cursor-grok-4.5-fast",
};

// resolvePrice mirrors PriceTable.ResolvePrice in pricing.go. Resolution
// order: exact key, alias map, then progressively shorter dash-delimited
// prefixes of the ORIGINAL model string (so "claude-opus-4-8-20260101"
// resolves to "claude-opus-4-8"). Cursor hook payloads often send the short
// Grok slug (grok-4.6) instead of the table key (cursor-grok-4.6); when the
// first pass misses and the slug starts with "grok-", retry as "cursor-"+slug.
// Case-sensitive throughout, like the Go code. Returns the matched table key
// alongside the rates so callers can dedupe (e.g. exclude the actual model
// from a comparison set).
export function resolvePrice(
  model: string,
): { key: string; price: ModelPrice } | undefined {
  if (model === "") {
    return undefined;
  }
  const hit = lookupPrice(model);
  if (hit) {
    return hit;
  }
  if (model.startsWith("grok-")) {
    return lookupPrice("cursor-" + model);
  }
  return undefined;
}

function lookupPrice(
  model: string,
): { key: string; price: ModelPrice } | undefined {
  const table = pricingTable();
  const exact = table[model];
  if (exact) {
    return { key: model, price: exact };
  }
  const canonical = MODEL_ALIASES[model];
  if (canonical !== undefined) {
    const aliased = table[canonical];
    if (aliased) {
      return { key: canonical, price: aliased };
    }
  }
  // Strip trailing dash-delimited segments one at a time and retry, so dated
  // or speed-suffixed IDs collapse to their base model key. Mirrors the Go
  // loop: stop when the last "-" is at index <= 0.
  let trimmed = model;
  for (;;) {
    const idx = trimmed.lastIndexOf("-");
    if (idx <= 0) {
      break;
    }
    trimmed = trimmed.slice(0, idx);
    const mp = table[trimmed];
    if (mp) {
      return { key: trimmed, price: mp };
    }
  }
  return undefined;
}

// Models offered in the "what would this have cost on…" comparison, per tool.
export const COMPARISON_MODELS: { claudeCode: string[]; cursor: string[] } = {
  claudeCode: [
    "claude-fable-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
  ],
  cursor: [
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "claude-haiku-4-5",
    "composer-2.5",
    "composer-2.5-fast",
    "cursor-grok-4.6",
    "cursor-grok-4.6-fast",
  ],
};
