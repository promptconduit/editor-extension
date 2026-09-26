import { describe, it, expect } from "vitest";
import { rateCardFromDocument } from "../../src/rateCard";

describe("rateCardFromDocument", () => {
  it("accepts a same-day PromptConduit card and skips zero rows", () => {
    const card = rateCardFromDocument({
      _source: "promptconduit",
      _updated: "2026-09-25",
      "cursor-grok-4.7": {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000006,
        cache_read_input_token_cost: 0.0000005,
      },
      "text-embedding-x": { input_cost_per_token: 0, output_cost_per_token: 0 },
    });
    expect(card?.["cursor-grok-4.7"]).toEqual({
      input: 0.000002,
      output: 0.000006,
      cacheRead: 0.0000005,
    });
    expect(card?.["text-embedding-x"]).toBeUndefined();
  });

  it("rejects an older card and a card that is not ours", () => {
    expect(
      rateCardFromDocument({
        _source: "promptconduit",
        _updated: "2020-01-01",
        "cursor-grok-4.7": { input_cost_per_token: 9, output_cost_per_token: 9 },
      }),
    ).toBeUndefined();
    expect(
      rateCardFromDocument({
        _updated: "2026-09-26",
        "cursor-grok-4.7": { input_cost_per_token: 9, output_cost_per_token: 9 },
      }),
    ).toBeUndefined();
  });
});
