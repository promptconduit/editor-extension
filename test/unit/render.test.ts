import { describe, it, expect } from "vitest";
import { signalsSummary } from "../../src/statusBar";
import { heavySummary, cleanSummary } from "../../dev/fixtures";
import type { SessionSummary } from "../../src/types";

// Stream panel rendering is covered in stream.test.ts (renderStreamBody) since
// the panel became a scripted webview in v0.16.0.

describe("signalsSummary (status-bar tooltip)", () => {
  it("renders the headline from a session's signals", () => {
    const s = signalsSummary(heavySummary);
    expect(s).toContain("cache hit 14%"); // 0.135 -> 14%
    expect(s).toContain("premium tier");
    expect(s).toContain("52 tool calls");
  });

  it("uses singular for one tool call and hides unknown tier", () => {
    const one: SessionSummary = { ...cleanSummary, signals: { ...cleanSummary.signals!, tier: "unknown", tool_calls: 1 } };
    const s = signalsSummary(one);
    expect(s).toContain("1 tool call");
    expect(s).not.toContain("tool calls");
    expect(s).not.toContain("tier");
  });

  it("returns empty string when a session has no signals", () => {
    expect(signalsSummary({ ...cleanSummary, signals: undefined })).toBe("");
  });
});
