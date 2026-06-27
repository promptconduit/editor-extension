import { describe, it, expect } from "vitest";
import { buildFeedHtml, parseLine } from "../../src/eventsFeed";
import { signalsSummary } from "../../src/statusBar";
import { sampleTelemetryLines, heavySummary, cleanSummary } from "../../dev/fixtures";
import type { SessionSummary } from "../../src/types";

describe("parseLine (telemetry feed)", () => {
  it("parses an envelope line into the fields the feed renders", () => {
    const fe = parseLine(sampleTelemetryLines[1]); // UserPromptSubmit on promptconduit
    expect(fe).not.toBeNull();
    expect(fe!.tool).toBe("claude-code");
    expect(fe!.hookEvent).toBe("UserPromptSubmit");
    expect(fe!.repo).toBe("promptconduit");
  });

  it("returns null for blank / malformed / non-object lines", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("{nope")).toBeNull();
    expect(parseLine("123")).toBeNull();
  });
});

describe("buildFeedHtml (telemetry panel)", () => {
  const events = sampleTelemetryLines.map(parseLine).filter((e): e is NonNullable<typeof e> => e !== null);

  it("renders rows for the seeded events", () => {
    const html = buildFeedHtml(events);
    expect(html).toContain("AI telemetry");
    expect(html).toContain("UserPromptSubmit");
    expect(html).toContain("claude-code");
    expect(html).toContain("editor-extension (feat/local-dx)");
  });

  it("shows the empty state when there are no events", () => {
    expect(buildFeedHtml([])).toContain("No events yet");
  });

  it("escapes HTML in event fields", () => {
    const evil = parseLine(
      JSON.stringify({ tool: "x", hook_event: "y", captured_at: "2026-06-27T00:00:00Z", enrichment: { git: { repo_name: "<script>", branch: "" } } }),
    );
    const html = buildFeedHtml([evil!]);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});

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
