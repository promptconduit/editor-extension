import { describe, it, expect } from "vitest";
import { buildTips } from "../../src/tips";
import { cleanSummary, heavySummary } from "../../dev/fixtures";
import type { SessionSummary } from "../../src/types";

const titles = (s: SessionSummary | undefined) => buildTips(s, undefined).map((t) => t.title);

describe("buildTips", () => {
  it("returns no tips when there is no session", () => {
    expect(buildTips(undefined, undefined)).toEqual([]);
  });

  it("returns no tips for a lean, well-cached session", () => {
    expect(buildTips(cleanSummary, undefined)).toEqual([]);
  });

  it("surfaces every reduction tip for a heavy session", () => {
    const t = titles(heavySummary);
    expect(t).toContain("Reuse context to hit the prompt cache");
    expect(t).toContain("Drop to a cheaper model for routine edits");
    expect(t).toContain("Trim the context you send each turn");
    expect(t).toContain("Batch tool calls where you can");
    expect(t).toContain("Some models are unpriced");
    expect(t).toHaveLength(5);
  });

  it("only flags premium tier (not standard/economy)", () => {
    const standard: SessionSummary = { ...cleanSummary, signals: { ...cleanSummary.signals!, tier: "premium" } };
    expect(titles(standard)).toContain("Drop to a cheaper model for routine edits");
    expect(titles(cleanSummary)).not.toContain("Drop to a cheaper model for routine edits");
  });

  it("flags high tool volume at the >=40 threshold", () => {
    const below: SessionSummary = { ...cleanSummary, tools: { total: 39 }, signals: { ...cleanSummary.signals!, tool_calls: 39 } };
    const at: SessionSummary = { ...cleanSummary, tools: { total: 40 }, signals: { ...cleanSummary.signals!, tool_calls: 40 } };
    expect(titles(below)).not.toContain("Batch tool calls where you can");
    expect(titles(at)).toContain("Batch tool calls where you can");
  });

  it("falls back to totals when a record predates the signals bundle", () => {
    // v1-style summary: no signals, but low cache hit + big uncached input.
    const v1: SessionSummary = {
      ...heavySummary,
      signals: undefined,
      tools: undefined,
      totals: { input: 40000, output: 5000, cache_read: 2000, cache_write: 1000, cost_total: 0, currency: "USD" },
    };
    // cost_total === 0 path → "reuse context" tip fires from the totals fallback.
    expect(titles(v1)).toContain("Reuse context to hit the prompt cache");
  });
});
