import { describe, it, expect } from "vitest";
import { renderBreakdownHtml } from "../../src/panel";
import { cleanSummary, heavySummary, sampleEvents } from "../../dev/fixtures";
import type { CostEvent, SessionSummary } from "../../src/types";

describe("renderBreakdownHtml — zero state", () => {
  const html = renderBreakdownHtml(undefined, undefined, []);

  it("shows the landing document when nothing has happened yet", () => {
    expect(html).toContain("AI Session Cost");
    expect(html).toContain("100% local");
  });

  it("still teaches: landing carries both Claude and Cursor doc links", () => {
    expect(html).toMatch(/claude\.com/);
    expect(html).toContain("cursor.com");
  });
});

describe("renderBreakdownHtml — priced session", () => {
  const html = renderBreakdownHtml(heavySummary, sampleEvents[2], sampleEvents);

  it("leads with the counterfactual API-cost framing", () => {
    expect(html).toContain("This session would cost");
    expect(html).toContain("Claude API pay-as-you-go rates"); // tool: claude-code
    expect(html).toContain("subscription");
    expect(html).toContain("$0.92"); // heavySummary cost_total, hero precision
  });

  it("renders every section of the breakdown", () => {
    expect(html).toContain("Cost per prompt");
    expect(html).toContain("What's driving your cost");
    expect(html).toContain("Make it cheaper");
    expect(html).toContain("Reading these numbers"); // edge cases (unpriced model present)
    expect(html).toContain("By model");
    expect(html).toContain("Learn more — spend fewer tokens");
  });

  it("draws a relative-cost bar for each prompt", () => {
    expect(html).toContain("bar-fill");
  });

  it("links cost-reduction docs for Claude and Cursor", () => {
    expect(html).toMatch(/href="https:\/\/[^"]*claude\.com/);
    expect(html).toMatch(/href="https:\/\/cursor\.com/);
  });

  it("keeps the 100%-local promise in the footer", () => {
    expect(html).toContain("None of your data is sent anywhere");
  });
});

describe("renderBreakdownHtml — tool awareness", () => {
  it("frames a Cursor session against generic API rates and the Cursor sub", () => {
    const cursor: SessionSummary = { ...cleanSummary, tool: "cursor" };
    const html = renderBreakdownHtml(cursor, undefined, []);
    expect(html).toContain("API pay-as-you-go rates");
    expect(html).not.toContain("Claude API pay-as-you-go rates");
  });
});

describe("renderBreakdownHtml — unpriced session", () => {
  it("shows 'Unpriced' rather than a misleading $0.00", () => {
    const unpriced: SessionSummary = {
      ...cleanSummary,
      source: "estimate",
      totals: { input: 5000, output: 1000, cache_read: 0, cache_write: 0, cost_total: 0, currency: "USD" },
      by_model: [
        { model: "composer-x", model_priced: false, tokens: { input: 5000, output: 1000, cache_read: 0, cache_write: 0 }, cost_total: 0 },
      ],
      signals: undefined,
    };
    const html = renderBreakdownHtml(unpriced, undefined, []);
    expect(html).toContain("Unpriced");
    expect(html).toContain("Tokens tracked this session");
    expect(html).toContain("Reading these numbers");
  });
});

describe("renderBreakdownHtml — escaping", () => {
  it("escapes HTML in model names from the feed", () => {
    const evil: CostEvent = {
      ...sampleEvents[0],
      model: "<script>alert(1)</script>",
      request_id: "evil-1",
    };
    const html = renderBreakdownHtml(heavySummary, evil, [evil]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
