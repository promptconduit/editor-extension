import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  PRICING,
  MODEL_ALIASES,
  resolvePrice,
  COMPARISON_MODELS,
  applyRateCard,
  BUNDLED_CARD_UPDATED,
  type ModelPrice,
} from "../../src/pricing";

describe("resolvePrice exact lookups", () => {
  it("returns claude-fable-5 rates verbatim", () => {
    const r = resolvePrice("claude-fable-5");
    expect(r).toBeDefined();
    expect(r!.key).toBe("claude-fable-5");
    expect(r!.price).toEqual({
      input: 0.00001,
      output: 0.00005,
      cacheRead: 0.000001,
      cacheWrite5m: 0.0000125,
      cacheWrite1h: 0.00002,
    });
  });

  it("returns claude-sonnet-4-6 rates verbatim", () => {
    const r = resolvePrice("claude-sonnet-4-6");
    expect(r!.key).toBe("claude-sonnet-4-6");
    expect(r!.price.input).toBe(0.000003);
    expect(r!.price.output).toBe(0.000015);
    expect(r!.price.cacheRead).toBe(0.0000003);
    expect(r!.price.cacheWrite5m).toBe(0.00000375);
    expect(r!.price.cacheWrite1h).toBe(0.000006);
  });

  it("returns composer-2.5 with cache-read only (no cache-write rate)", () => {
    const r = resolvePrice("composer-2.5");
    expect(r!.key).toBe("composer-2.5");
    expect(r!.price).toEqual({
      input: 0.0000005,
      output: 0.0000025,
      cacheRead: 0.0000002,
    });
    expect(r!.price.cacheWrite5m).toBeUndefined();
  });

  it("matches composer-2.5-fast exactly, not trimmed to composer-2.5", () => {
    const r = resolvePrice("composer-2.5-fast");
    expect(r!.key).toBe("composer-2.5-fast");
    expect(r!.price.input).toBe(0.000003);
    expect(r!.price.cacheRead).toBe(0.0000005);
  });

  it("resolves claude-sonnet-5 and thinking suffix variants", () => {
    const r = resolvePrice("claude-sonnet-5-thinking-high");
    expect(r!.key).toBe("claude-sonnet-5");
    expect(r!.price.input).toBe(0.000002);
  });

  it("resolves claude-opus-5-fast without trimming to standard opus-5", () => {
    const r = resolvePrice("claude-opus-5-fast");
    expect(r!.key).toBe("claude-opus-5-fast");
    expect(r!.price.input).toBe(0.00001);
    expect(r!.price.output).toBe(0.00005);
  });

  it("resolves cursor-grok-4.6-fast via alias, not the standard rate", () => {
    const r = resolvePrice("cursor-grok-4.6-high-fast");
    expect(r!.key).toBe("cursor-grok-4.6-fast");
    expect(r!.price.input).toBe(0.000004);
  });

  it("resolves cursor-grok-4.6-high via suffix trim to the standard rate", () => {
    const r = resolvePrice("cursor-grok-4.6-high");
    expect(r!.key).toBe("cursor-grok-4.6");
    expect(r!.price.input).toBe(0.000002);
  });

  it("resolves short grok-4.6 slugs via the cursor- prefix retry", () => {
    expect(resolvePrice("grok-4.6")!.key).toBe("cursor-grok-4.6");
    expect(resolvePrice("grok-4.6")!.price.input).toBe(0.000002);
    expect(resolvePrice("grok-4.6-high")!.key).toBe("cursor-grok-4.6");
    const fast = resolvePrice("grok-4.6-high-fast");
    expect(fast!.key).toBe("cursor-grok-4.6-fast");
    expect(fast!.price.input).toBe(0.000004);
  });

  it("resolves grok-4.5-fast-xhigh to the Grok 4.5 fast rate", () => {
    const r = resolvePrice("grok-4.5-fast-xhigh");
    expect(r!.key).toBe("cursor-grok-4.5-fast");
    expect(r!.price.input).toBe(0.000004);
    expect(r!.price.output).toBe(0.000018);
  });

  it("prices the 5.5 Claude models from the November card", () => {
    expect(resolvePrice("claude-sonnet-5-5")!.price.cacheRead).toBe(0.0000001);
    expect(resolvePrice("claude-opus-5.5")!.key).toBe("claude-opus-5-5");
    const haiku = resolvePrice("claude-haiku-5-5")!.price;
    expect(haiku.input).toBe(0.0000001);
    expect(haiku.longContextThreshold).toBe(100000);
    expect(haiku.longContext!.input).toBe(0.0000005);
  });

  it("keeps Claude Code fast-mode rows apart from Cursor -fast ids", () => {
    expect(resolvePrice("claude-opus-5-5@fast")!.price.input).toBe(0.000008);
    // "@" is not a dash segment, so a dated id never trims onto the fast row.
    expect(resolvePrice("claude-opus-5-5-20261101")!.key).toBe("claude-opus-5-5");
  });

  it("gives Cursor's smaller third-party variants their own rows", () => {
    for (const [model, input] of [
      ["gpt-5.4-mini", 0.00000075],
      ["gpt-5.4-nano", 0.0000002],
      ["gpt-5.1-codex-mini", 0.00000025],
      ["glm-5.3-flash", 0.00000015],
      ["gemini-3.5-flash-lite", 0.0000003],
    ] as const) {
      const r = resolvePrice(model);
      expect(r!.key).toBe(model);
      expect(r!.price.input).toBe(input);
    }
  });

  it("resolves gemini-3.7-flash-high via suffix trim", () => {
    const r = resolvePrice("gemini-3.7-flash-high");
    expect(r!.key).toBe("gemini-3.7-flash");
    expect(r!.price.output).toBe(0.00000375);
  });
});

describe("resolvePrice alias resolution", () => {
  it("resolves claude-4.5-sonnet via the alias map", () => {
    const r = resolvePrice("claude-4.5-sonnet");
    expect(r!.key).toBe("claude-sonnet-4-5");
    expect(r!.price.input).toBe(0.000003);
  });

  it("resolves claude-sonnet-4 via the alias map (not suffix trim)", () => {
    // Alias maps to -4-6; the trim loop could never reach it from this input.
    const r = resolvePrice("claude-sonnet-4");
    expect(r!.key).toBe("claude-sonnet-4-6");
  });

  it("composer-1 resolves via cursor-composer-1 alias", () => {
    const r = resolvePrice("composer-1");
    expect(r!.key).toBe("cursor-composer-1");
    expect(r!.price.input).toBe(0.00000125);
    expect(r!.price.output).toBe(0.00001);
  });

  it("resolves dated 3-5-haiku via the alias map", () => {
    const r = resolvePrice("claude-3-5-haiku-20241022");
    expect(r!.key).toBe("claude-3-5-haiku");
  });

  it("resolves dotted Sonnet/Haiku 5.5 ids (they used to go unpriced)", () => {
    expect(resolvePrice("claude-sonnet-5.5")!.key).toBe("claude-sonnet-5-5");
    expect(resolvePrice("claude-haiku-5.5")!.key).toBe("claude-haiku-5-5");
  });

  it("prices Cursor's GPT-5 Fast ids at the Fast rate, not gpt-5", () => {
    for (const id of ["gpt-5-high-fast", "gpt-5-low-fast"]) {
      const r = resolvePrice(id);
      expect(r!.key).toBe("gpt-5-fast");
      expect(r!.price.input).toBe(0.0000025);
      expect(r!.price.output).toBe(0.00002);
    }
    expect(resolvePrice("gpt-5-high")!.key).toBe("gpt-5");
  });
});

describe("Cursor fast-mode Opus ids", () => {
  it("claude-opus-5-5-fast bills at Opus 5.5 fast-mode rates", () => {
    const r = resolvePrice("claude-opus-5-5-fast");
    expect(r!.key).toBe("claude-opus-5-5-fast");
    expect(r!.price.input).toBe(0.000008);
    expect(r!.price.output).toBe(0.00004);
  });

  it("claude-opus-4-7-fast bills at Cursor's Opus 4.7 fast-mode rates", () => {
    const r = resolvePrice("claude-opus-4-7-fast");
    expect(r!.key).toBe("claude-opus-4-7-fast");
    expect(r!.price.input).toBe(0.00003);
    expect(r!.price.output).toBe(0.00015);
  });
});

describe("resolvePrice progressive suffix trim", () => {
  it("trims a date suffix: claude-opus-4-8-20250115 → claude-opus-4-8", () => {
    const r = resolvePrice("claude-opus-4-8-20250115");
    expect(r!.key).toBe("claude-opus-4-8");
    expect(r!.price.input).toBe(0.000005);
  });

  it("trims multiple segments one at a time", () => {
    const r = resolvePrice("claude-haiku-4-5-preview-20260101");
    expect(r!.key).toBe("claude-haiku-4-5");
  });

  it("stops when the last dash is at index 0 (Go: idx <= 0 breaks)", () => {
    expect(resolvePrice("-unknown")).toBeUndefined();
  });

  it("returns undefined for unknown models and empty string", () => {
    expect(resolvePrice("llama-9-turbo")).toBeUndefined();
    expect(resolvePrice("totally-unknown-model")).toBeUndefined();
    expect(resolvePrice("")).toBeUndefined();
  });

  it("is case-sensitive like the Go code (no folding)", () => {
    expect(resolvePrice("Claude-Fable-5")).toBeUndefined();
  });
});

describe("COMPARISON_MODELS", () => {
  it("cursor is the claude-code set plus the composer models", () => {
    expect(COMPARISON_MODELS.claudeCode).toEqual([
      "claude-fable-5",
      "claude-opus-5-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-5-5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
    expect(COMPARISON_MODELS.cursor).toEqual([
      "claude-fable-5",
      "claude-opus-5-5",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-5-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "composer-2.5",
      "composer-2.5-fast",
      "cursor-grok-4.6",
      "cursor-grok-4.6-fast",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Parity with the CLI's bundled snapshot. PRICING is MIRRORED from
// cli/internal/cost/pricing_data.json; when that repo is checked out next to
// this one (the promptconduit multi-repo workspace layout), verify every
// model and every rate matches exactly, in both directions. Skipped when the
// cli repo isn't present (e.g. standalone CI of this repo).
// ---------------------------------------------------------------------------

const CLI_JSON_REL = ["cli", "internal", "cost", "pricing_data.json"];

function findCliPricingJson(): string | undefined {
  // CI checks out promptconduit/cli and points here (see .github/workflows/ci.yml).
  const fromEnv = process.env.PROMPTCONDUIT_CLI_PRICING_JSON;
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) {
      throw new Error(`PROMPTCONDUIT_CLI_PRICING_JSON points at a missing file: ${fromEnv}`);
    }
    return fromEnv;
  }
  const roots = [
    path.resolve(__dirname, "..", ".."), // repo root from test/unit/
    process.cwd(), // vitest usually runs from the repo root
  ];
  for (const root of roots) {
    // The cli repo is a sibling of this repo in the workspace; also walk a
    // couple of levels up to tolerate worktree checkouts.
    for (const up of ["..", path.join("..", "..")]) {
      const candidate = path.join(root, up, ...CLI_JSON_REL);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

const cliJsonPath = findCliPricingJson();

describe("parity with cli/internal/cost/pricing_data.json", () => {
  it.skipIf(!cliJsonPath)("PRICING mirrors the CLI table exactly", () => {
    const raw = JSON.parse(fs.readFileSync(cliJsonPath!, "utf8")) as Record<string, unknown>;
    type Row = Record<string, number | Row | undefined>;
    const toPrice = (val: Row): ModelPrice => ({
      input: val.input_cost_per_token as number,
      output: val.output_cost_per_token as number,
      ...(val.cache_read_input_token_cost !== undefined && {
        cacheRead: val.cache_read_input_token_cost as number,
      }),
      ...(val.cache_creation_input_token_cost !== undefined && {
        cacheWrite5m: val.cache_creation_input_token_cost as number,
      }),
      ...(val.cache_creation_input_token_cost_1h !== undefined && {
        cacheWrite1h: val.cache_creation_input_token_cost_1h as number,
      }),
      ...(val.long_context_threshold_tokens !== undefined && {
        longContextThreshold: val.long_context_threshold_tokens as number,
      }),
      ...(val.long_context !== undefined && {
        longContext: toPrice(val.long_context as Row),
      }),
    });
    const expected: Record<string, ModelPrice> = {};
    for (const [key, val] of Object.entries(raw)) {
      if (key.startsWith("_")) continue; // metadata keys ("_comment", …)
      expected[key] = toPrice(val as Row);
    }
    // toEqual is symmetric on plain objects: this asserts every CLI model +
    // rate is present and identical, AND that PRICING has no extra models.
    expect(PRICING).toEqual(expected);
  });

  it.skipIf(!cliJsonPath)("BUNDLED_CARD_UPDATED matches the CLI card date", () => {
    const raw = JSON.parse(fs.readFileSync(cliJsonPath!, "utf8")) as { _updated: string };
    expect(BUNDLED_CARD_UPDATED).toBe(raw._updated);
  });
});

describe("published rate card overlay", () => {
  it("overrides a bundled row and restores it when cleared", () => {
    const bundled = resolvePrice("cursor-grok-4.7");
    expect(bundled?.price.input).toBe(0.000002);
    try {
      applyRateCard({
        "cursor-grok-4.7": { input: 0.000009, output: 0.000009, cacheRead: 0.000001 },
        "gpt-6-astra": { input: 0.000003, output: 0.000004 },
      });
      expect(resolvePrice("cursor-grok-4.7")?.price.input).toBe(0.000009);
      expect(resolvePrice("grok-4.7-high")?.price.input).toBe(0.000009);
      expect(resolvePrice("gpt-6-astra")?.price.input).toBe(0.000003);
      expect(PRICING["cursor-grok-4.7"].input).toBe(0.000002);
    } finally {
      applyRateCard(undefined);
    }
    expect(resolvePrice("cursor-grok-4.7")?.price.input).toBe(0.000002);
    expect(resolvePrice("gpt-6-astra")).toBeUndefined();
  });
});
