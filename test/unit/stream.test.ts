import { describe, it, expect } from "vitest";
import {
  parseStreamLine,
  StreamState,
  buildStreamHtml,
  shortId,
  type StreamEvent,
} from "../../src/streamFeed";
import { sampleStreamLines, sampleEnrichmentLines } from "../../dev/fixtures";

function envelope(
  ids: { session_id?: string; conversation_id?: string },
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schema: 2,
    event_id: "evt-1",
    ...(ids.session_id ? { session_id: ids.session_id } : {}),
    tool: "cursor",
    hook_event: "beforeSubmitPrompt",
    captured_at: "2026-06-30T17:00:00Z",
    cli_version: "dev",
    raw_event: { ...(ids.conversation_id !== undefined ? { conversation_id: ids.conversation_id } : {}) },
    enrichments: { vcs: { repo: "promptconduit/cli", branch: "main" } },
    ...extra,
  });
}

function mk(p: Partial<StreamEvent>): StreamEvent {
  return {
    sessionKey: "A",
    tool: "cursor",
    hookEvent: "beforeSubmitPrompt",
    capturedAt: "2026-06-30T17:00:00Z",
    repo: "promptconduit/cli",
    branch: "main",
    subagentBadge: "",
    toolsSummary: "",
    ...p,
  };
}

describe("parseStreamLine", () => {
  it("prefers conversation_id over session_id for the session key", () => {
    const ev = parseStreamLine(envelope({ conversation_id: "tab-A", session_id: "sess-A" }));
    expect(ev?.sessionKey).toBe("tab-A");
  });

  it("falls back to session_id when conversation_id is absent/empty", () => {
    expect(parseStreamLine(envelope({ session_id: "cc-1" }))?.sessionKey).toBe("cc-1");
    expect(parseStreamLine(envelope({ conversation_id: "", session_id: "cc-1" }))?.sessionKey).toBe("cc-1");
  });

  it("extracts tool, hook event, captured_at, and repo/branch from vcs", () => {
    const ev = parseStreamLine(
      envelope({ session_id: "s" }, { tool: "claude-code", hook_event: "PreToolUse", captured_at: "2026-06-30T18:00:00Z" }),
    );
    expect(ev).toMatchObject({
      tool: "claude-code",
      hookEvent: "PreToolUse",
      capturedAt: "2026-06-30T18:00:00Z",
      repo: "promptconduit/cli",
      branch: "main",
      subagentBadge: "",
      toolsSummary: "",
    });
  });

  it("reads subagent badge and tools summary from enrichment slugs", () => {
    const subStart = parseStreamLine(sampleEnrichmentLines[0]);
    expect(subStart?.subagentBadge).toBe("Explore start");
    const tools = parseStreamLine(sampleEnrichmentLines[4]);
    expect(tools?.toolsSummary).toBe("3 tools · 1 failed");
  });

  it("returns null for blank, malformed, non-object, pre-v2, or session-less lines", () => {
    expect(parseStreamLine("")).toBeNull();
    expect(parseStreamLine("   ")).toBeNull();
    expect(parseStreamLine("{not json")).toBeNull();
    expect(parseStreamLine("42")).toBeNull();
    expect(parseStreamLine(envelope({}))).toBeNull(); // no session key
    expect(parseStreamLine(JSON.stringify({ tool: "cursor", native_payload: { session_id: "s" } }))).toBeNull(); // v1 line
  });
});

describe("StreamState follow/pin logic", () => {
  it("follows the most-recently-active session by timestamp", () => {
    const s = new StreamState();
    s.record(mk({ sessionKey: "A", capturedAt: "2026-06-30T17:00:00Z" }));
    s.record(mk({ sessionKey: "B", capturedAt: "2026-06-30T17:05:00Z" }));
    expect(s.followedKey).toBe("B");
  });

  it("switches active when an older session produces a newer event", () => {
    const s = new StreamState();
    s.record(mk({ sessionKey: "A", capturedAt: "2026-06-30T17:00:00Z" }));
    s.record(mk({ sessionKey: "B", capturedAt: "2026-06-30T17:05:00Z" }));
    expect(s.followedKey).toBe("B");
    s.record(mk({ sessionKey: "A", capturedAt: "2026-06-30T17:10:00Z" }));
    expect(s.followedKey).toBe("A");
  });

  it("pin overrides auto-follow; unpin resumes following the active session", () => {
    const s = new StreamState();
    s.record(mk({ sessionKey: "A", capturedAt: "2026-06-30T17:00:00Z" }));
    s.record(mk({ sessionKey: "B", capturedAt: "2026-06-30T17:05:00Z" }));
    s.pin("A");
    expect(s.followedKey).toBe("A");
    expect(s.isPinned).toBe(true);
    // A newer event on B must NOT steal the pinned view.
    s.record(mk({ sessionKey: "B", capturedAt: "2026-06-30T17:09:00Z" }));
    expect(s.followedKey).toBe("A");
    s.unpin();
    expect(s.isPinned).toBe(false);
    expect(s.followedKey).toBe("B");
  });

  it("ignores a pin for a session it has never seen (stays on active)", () => {
    const s = new StreamState();
    s.record(mk({ sessionKey: "A", capturedAt: "2026-06-30T17:00:00Z" }));
    s.pin("ghost");
    expect(s.isPinned).toBe(false);
    expect(s.followedKey).toBe("A");
  });

  it("buffers events per session (following A never shows B's events)", () => {
    const s = new StreamState();
    s.record(mk({ sessionKey: "A", hookEvent: "A-evt", capturedAt: "2026-06-30T17:00:00Z" }));
    s.record(mk({ sessionKey: "B", hookEvent: "B-evt", capturedAt: "2026-06-30T17:05:00Z" }));
    s.pin("A");
    const buf = s.followedBuf();
    expect(buf?.key).toBe("A");
    expect(buf?.events.map((e) => e.hookEvent)).toEqual(["A-evt"]);
  });

  it("bounds each session buffer to 200 events (drops oldest)", () => {
    const s = new StreamState();
    for (let i = 0; i < 250; i++) {
      s.record(mk({ sessionKey: "A", hookEvent: `e${i}`, capturedAt: `2026-06-30T17:00:${String(i % 60).padStart(2, "0")}Z` }));
    }
    const buf = s.followedBuf();
    expect(buf?.events).toHaveLength(200);
    expect(buf?.events[0].hookEvent).toBe("e50"); // oldest 50 dropped
    expect(buf?.events[199].hookEvent).toBe("e249");
  });

  it("lists sessions newest-first with per-session counts and latest tool", () => {
    const s = new StreamState();
    s.record(mk({ sessionKey: "A", tool: "cursor", capturedAt: "2026-06-30T17:00:00Z" }));
    s.record(mk({ sessionKey: "A", tool: "cursor", capturedAt: "2026-06-30T17:00:05Z" }));
    s.record(mk({ sessionKey: "B", tool: "claude-code", capturedAt: "2026-06-30T17:05:00Z" }));
    const list = s.listSessions();
    expect(list.map((x) => x.key)).toEqual(["B", "A"]); // newest first
    expect(list.find((x) => x.key === "A")?.count).toBe(2);
    expect(list.find((x) => x.key === "B")?.tool).toBe("claude-code");
  });

  it("starts empty", () => {
    const s = new StreamState();
    expect(s.followedKey).toBeUndefined();
    expect(s.followedBuf()).toBeUndefined();
    expect(s.listSessions()).toEqual([]);
  });
});

describe("buildStreamHtml", () => {
  // Drive the real pipeline: parse the fixtures, feed StreamState, render the
  // auto-followed session (tab-B produces the newest event).
  function renderFromFixtures(pinKey?: string): string {
    const s = new StreamState();
    for (const line of sampleStreamLines) {
      const ev = parseStreamLine(line);
      if (ev) s.record(ev);
    }
    if (pinKey) s.pin(pinKey);
    return buildStreamHtml(s.followedBuf(), s.isPinned);
  }

  it("renders only the followed session's events", () => {
    const html = renderFromFixtures();
    // tab-B is newest → its events show, tab-A / claude-code events do not.
    expect(html).toContain("afterAgentResponse"); // tab-B event
    expect(html).toContain("auto-following");
    expect(html).not.toContain("beforeShellExecution"); // tab-A only
    expect(html).not.toContain("PreToolUse"); // claude-code session cc-1 only
  });

  it("shows the pinned badge and follows the pinned session", () => {
    const html = renderFromFixtures("cc-1");
    expect(html).toContain("📌 pinned");
    expect(html).toContain("PreToolUse"); // cc-1's event
    expect(html).toContain("UserPromptSubmit");
    expect(html).not.toContain("afterAgentResponse"); // tab-B not shown while pinned to cc-1
  });

  it("renders an empty state when no session is followed", () => {
    const html = buildStreamHtml(undefined, false);
    expect(html).toContain("No sessions yet");
    expect(html).toContain("Live stream");
  });

  it("escapes event values to keep the webview script-free", () => {
    const buf = { key: "s", tool: "<script>", events: [mk({ hookEvent: "<img>" })] };
    const html = buildStreamHtml(buf, false);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img&gt;");
  });
});

describe("shortId", () => {
  it("keeps short keys verbatim and tails long ones", () => {
    expect(shortId("abc")).toBe("abc");
    expect(shortId("0123456789abcdef0123")).toBe("…cdef0123");
  });
});
