import { describe, it, expect } from "vitest";
import {
  compareModels,
  cacheRatesFor,
  COMPARISON_CAVEAT,
  ModelComparison,
} from "../../src/costPanel/comparison";
import type { ModelTotal } from "../../src/types";

function opusActual(overrides: Partial<ModelTotal> = {}): ModelTotal {
  // Hand-priced at the mirrored claude-opus-4-8 rates:
  //   input  1000 × 0.000005   = 0.005
  //   output  500 × 0.000025   = 0.0125
  //   c.read 10000 × 0.0000005 = 0.005
  //   c.write 2000 × 0.00000625 = 0.0125   (5m rate)
  //   total                     = 0.035
  return {
    model: "claude-opus-4-8",
    model_priced: true,
    tokens: { input: 1000, output: 500, cache_read: 10000, cache_write: 2000 },
    cost_total: 0.035,
    ...overrides,
  };
}

function byModel(result: ModelComparison[] | { unpriced: true }, model: string): ModelComparison {
  const list = result as ModelComparison[];
  const found = list.find((c) => c.model === model);
  expect(found, `expected ${model} in comparison`).toBeDefined();
  return found!;
}

describe("compareModels known-rate math (claude-code)", () => {
  const result = compareModels(opusActual(), "claude-code");

  it("excludes the actual model and covers the rest of the set", () => {
    const list = result as ModelComparison[];
    expect(Array.isArray(list)).toBe(true);
    expect(list.map((c) => c.model).sort()).toEqual(
      ["claude-fable-5", "claude-haiku-4-5", "claude-sonnet-4-6"].sort(),
    );
  });

  it("sonnet-4-6 is cheaper, hand-computed", () => {
    // 1000×0.000003 + 500×0.000015 + 10000×0.0000003 + 2000×0.00000375
    // = 0.003 + 0.0075 + 0.003 + 0.0075 = 0.021
    const c = byModel(result, "claude-sonnet-4-6");
    expect(c.altUsd).toBeCloseTo(0.021, 10);
    expect(c.deltaUsd).toBeCloseTo(-0.014, 10);
    expect(c.deltaPct).toBeCloseTo(-0.4, 10);
    expect(c.cheaper).toBe(true);
    expect(c.derivedCacheRates).toBe(false);
  });

  it("fable-5 is more expensive, hand-computed", () => {
    // 1000×0.00001 + 500×0.00005 + 10000×0.000001 + 2000×0.0000125
    // = 0.01 + 0.025 + 0.01 + 0.025 = 0.07
    const c = byModel(result, "claude-fable-5");
    expect(c.altUsd).toBeCloseTo(0.07, 10);
    expect(c.deltaUsd).toBeCloseTo(0.035, 10);
    expect(c.deltaPct).toBeCloseTo(1.0, 10);
    expect(c.cheaper).toBe(false);
  });

  it("haiku-4-5 hand-computed, and results sort cheapest-first", () => {
    // 1000×0.000001 + 500×0.000005 + 10000×0.0000001 + 2000×0.00000125
    // = 0.001 + 0.0025 + 0.001 + 0.0025 = 0.007
    const c = byModel(result, "claude-haiku-4-5");
    expect(c.altUsd).toBeCloseTo(0.007, 10);
    const list = result as ModelComparison[];
    expect(list.map((m) => m.model)).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
      "claude-fable-5",
    ]);
  });
});

describe("compareModels tool-aware sets", () => {
  it("cursor includes composer models, claude-code does not", () => {
    const cursor = compareModels(opusActual(), "cursor") as ModelComparison[];
    expect(cursor.map((c) => c.model)).toContain("composer-2.5");
    expect(cursor.map((c) => c.model)).toContain("composer-2.5-fast");

    const cc = compareModels(opusActual(), "claude-code") as ModelComparison[];
    expect(cc.map((c) => c.model)).not.toContain("composer-2.5");
  });

  it("unknown tools fall back to the claude-code set", () => {
    const other = compareModels(opusActual(), "gemini-cli") as ModelComparison[];
    expect(other.map((c) => c.model)).not.toContain("composer-2.5");
    expect(other).toHaveLength(3);
  });

  it("composer cache tokens are priced at 0 (Cursor publishes no cache rate) and NOT flagged derived", () => {
    const cursor = compareModels(opusActual(), "cursor") as ModelComparison[];
    const composer = cursor.find((c) => c.model === "composer-2.5")!;
    // 1000×0.0000005 + 500×0.0000025 + cache priced at 0
    expect(composer.altUsd).toBeCloseTo(0.0005 + 0.00125, 10);
    expect(composer.derivedCacheRates).toBe(false);
  });

  it("excludes the actual model via its RESOLVED key (dated variant)", () => {
    const dated = opusActual({ model: "claude-opus-4-8-20260101" });
    const list = compareModels(dated, "claude-code") as ModelComparison[];
    expect(list.map((c) => c.model)).not.toContain("claude-opus-4-8");
    expect(list).toHaveLength(3);
  });
});

describe("cacheRatesFor derivation", () => {
  it("derives 0.1x/1.25x for a non-composer model missing cache rates", () => {
    const r = cacheRatesFor("some-future-model", { input: 0.000004, output: 0.00002 });
    expect(r.derived).toBe(true);
    expect(r.cacheRead).toBeCloseTo(0.0000004, 12);
    expect(r.cacheWrite5m).toBeCloseTo(0.000005, 12);
  });

  it("keeps composer cache at 0 without the derived flag", () => {
    const r = cacheRatesFor("composer-2.5", { input: 0.0000005, output: 0.0000025 });
    expect(r).toEqual({ cacheRead: 0, cacheWrite5m: 0, derived: false });
  });

  it("passes through real cache rates untouched", () => {
    const r = cacheRatesFor("claude-opus-4-8", {
      input: 0.000005,
      output: 0.000025,
      cacheRead: 0.0000005,
      cacheWrite5m: 0.00000625,
    });
    expect(r).toEqual({ cacheRead: 0.0000005, cacheWrite5m: 0.00000625, derived: false });
  });
});

describe("compareModels unpriced handling", () => {
  it("returns {unpriced:true} for a model missing from the table", () => {
    const result = compareModels(opusActual({ model: "gpt-5-turbo" }), "claude-code");
    expect(result).toEqual({ unpriced: true });
  });

  it("returns {unpriced:true} when the actual event was not priced", () => {
    const result = compareModels(opusActual({ model_priced: false }), "claude-code");
    expect(result).toEqual({ unpriced: true });
  });

  it("deltaPct is 0 when actual cost_total is 0", () => {
    const zero = opusActual({
      tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      cost_total: 0,
    });
    const list = compareModels(zero, "claude-code") as ModelComparison[];
    for (const c of list) {
      expect(c.deltaPct).toBe(0);
      expect(c.altUsd).toBe(0);
    }
  });
});

describe("COMPARISON_CAVEAT", () => {
  it("frames the numbers as a rate comparison", () => {
    expect(COMPARISON_CAVEAT).toContain("rate comparison");
    expect(COMPARISON_CAVEAT).toContain("identical token counts");
  });
});
