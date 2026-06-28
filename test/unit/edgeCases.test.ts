import { describe, it, expect } from "vitest";
import { buildEdgeCases } from "../../src/edgeCases";
import { cleanSummary, heavySummary } from "../../dev/fixtures";
import type { CostEvent, SessionSummary } from "../../src/types";

const ids = (s: SessionSummary | undefined, e?: CostEvent) => buildEdgeCases(s, e).map((c) => c.id);

describe("buildEdgeCases", () => {
  it("returns nothing when there's no data at all", () => {
    expect(buildEdgeCases(undefined, undefined)).toEqual([]);
  });

  it("flags unpriced models with a fix and a pricing link", () => {
    const cases = buildEdgeCases(heavySummary, undefined); // has an unpriced composer model
    const unpriced = cases.find((c) => c.id === "unpriced");
    expect(unpriced).toBeDefined();
    expect(unpriced!.severity).toBe("warn");
    expect(unpriced!.resolution).toContain("refresh-pricing");
    expect(unpriced!.link!.href).toMatch(/^https:\/\//);
  });

  it("explains estimated counts and how to capture exact usage", () => {
    const est: SessionSummary = { ...cleanSummary, source: "estimate" };
    const c = buildEdgeCases(est, undefined).find((x) => x.id === "estimate");
    expect(c).toBeDefined();
    expect(c!.severity).toBe("warn");
    expect(c!.resolution).toContain("install cursor");
  });

  it("notes reconciled counts as accurate (info, no action)", () => {
    const rec: SessionSummary = { ...cleanSummary, source: "reconciled" };
    const c = buildEdgeCases(rec, undefined).find((x) => x.id === "reconciled");
    expect(c).toBeDefined();
    expect(c!.severity).toBe("info");
  });

  it("frames a priced session as the API pay-as-you-go equivalent", () => {
    const c = buildEdgeCases(cleanSummary, undefined).find((x) => x.id === "api-equivalent");
    expect(c).toBeDefined();
    expect(c!.detail.toLowerCase()).toContain("subscription");
  });

  it("a clean exact session only carries the api-equivalent note", () => {
    expect(ids(cleanSummary)).toEqual(["api-equivalent"]);
  });

  it("derives the pricing link from the active tool", () => {
    const cursorUnpriced: SessionSummary = { ...heavySummary, tool: "cursor" };
    const c = buildEdgeCases(cursorUnpriced, undefined).find((x) => x.id === "unpriced");
    expect(c!.link!.href).toContain("cursor.com");
  });
});
