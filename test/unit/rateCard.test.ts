import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { rateCardFromDocument, readPublishedRateCard } from "../../src/rateCard";

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

describe("readPublishedRateCard", () => {
  it("re-parses only when the card file changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-card-"));
    const file = path.join(dir, "pricing-card.json");
    const doc = (rate: number) =>
      JSON.stringify({
        _source: "promptconduit",
        _updated: "2099-01-01",
        m: { input_cost_per_token: rate, output_cost_per_token: rate },
      });
    try {
      fs.writeFileSync(file, doc(1));
      const first = readPublishedRateCard(file);
      expect(first?.m.input).toBe(1);
      expect(readPublishedRateCard(file)).toBe(first); // cached object, no re-parse
      fs.writeFileSync(file, doc(22)); // size changes too
      fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
      expect(readPublishedRateCard(file)?.m.input).toBe(22);
      fs.rmSync(file);
      expect(readPublishedRateCard(file)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
