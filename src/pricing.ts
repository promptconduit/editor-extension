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
export const PRICING: Record<string, ModelPrice> = {
  "claude-fable-5": {
    input: 0.00001,
    output: 0.00005,
    cacheRead: 0.000001,
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
    input: 0.000003,
    output: 0.000015,
    cacheRead: 0.0000003,
    cacheWrite5m: 0.00000375,
    cacheWrite1h: 0.000006,
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
  // Cursor's own Composer models. Cursor publishes input/output rates only —
  // no cache rates — so cache tokens are (deliberately) priced at 0, matching
  // the CLI. The exact "-fast" key must exist so it doesn't suffix-trim down
  // to the cheaper standard rate.
  "composer-2.5-fast": {
    input: 0.000003,
    output: 0.000015,
  },
  "composer-2.5": {
    input: 0.0000005,
    output: 0.0000025,
  },
};

// Mirrors pricing.go modelAliases. Kept small on purpose — resolvePrice also
// does suffix-stripping, so this only needs the genuinely irregular cases.
// NOTE: "composer-1" → "cursor-composer-1" is mirrored verbatim from the Go
// map even though "cursor-composer-1" is not in the bundled table (the CLI
// can layer it in from a refreshed pricing cache; we cannot), so here it
// resolves to undefined — same result as the CLI with no cache.
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
};

// resolvePrice mirrors PriceTable.ResolvePrice in pricing.go. Resolution
// order: exact key, alias map, then progressively shorter dash-delimited
// prefixes of the ORIGINAL model string (so "claude-opus-4-8-20260101"
// resolves to "claude-opus-4-8"). Case-sensitive throughout, like the Go
// code. Returns the matched table key alongside the rates so callers can
// dedupe (e.g. exclude the actual model from a comparison set).
export function resolvePrice(
  model: string,
): { key: string; price: ModelPrice } | undefined {
  if (model === "") {
    return undefined;
  }
  const exact = PRICING[model];
  if (exact) {
    return { key: model, price: exact };
  }
  const canonical = MODEL_ALIASES[model];
  if (canonical !== undefined) {
    const aliased = PRICING[canonical];
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
    const mp = PRICING[trimmed];
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
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
  ],
  cursor: [
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "composer-2.5",
    "composer-2.5-fast",
  ],
};
