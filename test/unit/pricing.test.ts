import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { PRICING, MODEL_ALIASES, resolvePrice, COMPARISON_MODELS } from "../../src/pricing";

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

  it("returns composer-2.5 with no cache rates (Cursor publishes none)", () => {
    const r = resolvePrice("composer-2.5");
    expect(r!.key).toBe("composer-2.5");
    expect(r!.price).toEqual({ input: 0.0000005, output: 0.0000025 });
    expect(r!.price.cacheRead).toBeUndefined();
    expect(r!.price.cacheWrite5m).toBeUndefined();
  });

  it("matches composer-2.5-fast exactly, not trimmed to composer-2.5", () => {
    const r = resolvePrice("composer-2.5-fast");
    expect(r!.key).toBe("composer-2.5-fast");
    expect(r!.price.input).toBe(0.000003);
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

  it("composer-1 aliases to cursor-composer-1, which is not in the bundled table → undefined", () => {
    // Mirrors the Go behavior with the bundled snapshot only: the alias
    // exists but its target key isn't in pricing_data.json, and the trim
    // fallback ("composer") doesn't match either, so resolution fails.
    expect(MODEL_ALIASES["composer-1"]).toBe("cursor-composer-1");
    expect(resolvePrice("composer-1")).toBeUndefined();
  });

  it("resolves dated 3-5-haiku via the alias map", () => {
    const r = resolvePrice("claude-3-5-haiku-20241022");
    expect(r!.key).toBe("claude-3-5-haiku");
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
    expect(resolvePrice("gpt-5-turbo")).toBeUndefined();
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
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
    expect(COMPARISON_MODELS.cursor).toEqual([
      ...COMPARISON_MODELS.claudeCode,
      "composer-2.5",
      "composer-2.5-fast",
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
    const raw = JSON.parse(fs.readFileSync(cliJsonPath!, "utf8")) as Record<
      string,
      Record<string, number>
    >;
    const expected: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(raw)) {
      if (key.startsWith("_")) continue; // metadata keys ("_comment", …)
      expected[key] = {
        input: val.input_cost_per_token,
        output: val.output_cost_per_token,
        ...(val.cache_read_input_token_cost !== undefined && {
          cacheRead: val.cache_read_input_token_cost,
        }),
        ...(val.cache_creation_input_token_cost !== undefined && {
          cacheWrite5m: val.cache_creation_input_token_cost,
        }),
        ...(val.cache_creation_input_token_cost_1h !== undefined && {
          cacheWrite1h: val.cache_creation_input_token_cost_1h,
        }),
      };
    }
    // toEqual is symmetric on plain objects: this asserts every CLI model +
    // rate is present and identical, AND that PRICING has no extra models.
    expect(PRICING).toEqual(expected);
  });
});
