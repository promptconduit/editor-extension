import { describe, it, expect } from "vitest";
import { lastRequestLabel, fmtUSD } from "../../src/statusBar";
import type { CostEvent } from "../../src/types";

function ev(p: Partial<CostEvent>): CostEvent {
  return {
    tool: "claude-code", session_id: "s", request_id: "r",
    ts: "2026-07-06T12:00:00Z", model: "claude-opus-4-8", model_priced: true, source: "exact",
    cwd_base: "x",
    tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0.42, currency: "USD" },
    ...p,
  };
}

describe("lastRequestLabel", () => {
  it("formats a priced request as USD", () => {
    expect(lastRequestLabel(ev({}))).toBe(fmtUSD(0.42));
  });

  it("never shows $0.0000 for an unpriced model", () => {
    const e = ev({
      model: "some-new-model",
      model_priced: false,
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, currency: "USD" },
    });
    expect(lastRequestLabel(e)).toBe("unpriced");
  });
});
