import { describe, it, expect } from "vitest";
import { buildStreamHtml, parseStreamLine } from "../../src/streamFeed";
import { signalsSummary } from "../../src/statusBar";
import { sampleTelemetryLines, heavySummary, cleanSummary } from "../../dev/fixtures";
import type { SessionSummary } from "../../src/types";

describe("stream rendering (repo/branch merged from the old telemetry feed)", () => {
  const events = sampleTelemetryLines
    .map(parseStreamLine)
    .filter((e): e is NonNullable<typeof e> => e !== null);

  it("renders rows with tool, event, and repo@branch", () => {
    const buf = { key: "cc-t", tool: "claude-code", events: events.filter((e) => e.sessionKey === "cc-t") };
    const html = buildStreamHtml(buf, false);
    expect(html).toContain("UserPromptSubmit");
    expect(html).toContain("claude-code");
    expect(html).toContain("promptconduit/platform @ main");
  });

  it("shows the empty state when nothing is followed yet", () => {
    expect(buildStreamHtml(undefined, false)).toContain("No sessions yet");
  });

  it("escapes HTML in event fields", () => {
    const evil = parseStreamLine(
      JSON.stringify({
        schema: 2,
        event_id: "e",
        session_id: "s",
        tool: "x",
        hook_event: "y",
        captured_at: "2026-06-27T00:00:00Z",
        cli_version: "dev",
        raw_event: {},
        enrichments: { vcs: { repo: "<script>", branch: "" } },
      }),
    );
    const html = buildStreamHtml({ key: "s", tool: "x", events: [evil!] }, false);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
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
