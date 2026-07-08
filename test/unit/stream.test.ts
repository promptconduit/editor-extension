import { describe, it, expect } from "vitest";
import {
  parseStreamLine,
  StreamState,
  buildStreamPanelState,
  shortId,
  MAX_EVENTS,
  MAX_SESSIONS,
  RAW_JSON_MAX,
  SESSION_RAW_BUDGET,
  type StreamEvent,
} from "../../src/streamFeed";
import { renderStreamBody } from "../../webview/streamPanel/render";
import type { StreamPanelState } from "../../src/streamPanel/protocol";
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
    eventId: "evt-x",
    tool: "cursor",
    hookEvent: "beforeSubmitPrompt",
    capturedAt: "2026-06-30T17:00:00Z",
    repo: "promptconduit/cli",
    branch: "main",
    subagentBadge: "",
    toolsSummary: "",
    rawJson: undefined,
    rawTruncated: false,
    keyIsConversationId: false,
    ...p,
  };
}

function stateFor(
  buf: { key: string; tool: string; keyIsConversationId?: boolean; events: StreamEvent[] } | undefined,
  pinned = false,
): StreamPanelState {
  return {
    revision: 1,
    pinned,
    logDisabled: false,
    session: buf
      ? {
          key: buf.key,
          tool: buf.tool,
          keyIsConversationId: buf.keyIsConversationId ?? false,
          count: buf.events.length,
        }
      : undefined,
    events: buf?.events ?? [],
  };
}

describe("parseStreamLine", () => {
  it("prefers conversation_id over session_id for the session key", () => {
    const ev = parseStreamLine(envelope({ conversation_id: "tab-A", session_id: "sess-A" }));
    expect(ev?.sessionKey).toBe("tab-A");
    expect(ev?.keyIsConversationId).toBe(true);
  });

  it("falls back to session_id when conversation_id is absent/empty", () => {
    const bySession = parseStreamLine(envelope({ session_id: "cc-1" }));
    expect(bySession?.sessionKey).toBe("cc-1");
    expect(bySession?.keyIsConversationId).toBe(false);
    expect(parseStreamLine(envelope({ conversation_id: "", session_id: "cc-1" }))?.sessionKey).toBe("cc-1");
  });

  it("extracts tool, hook event, captured_at, and repo/branch from vcs", () => {
    const ev = parseStreamLine(
      envelope({ session_id: "s" }, { tool: "claude-code", hook_event: "PreToolUse", captured_at: "2026-06-30T18:00:00Z" }),
    );
    expect(ev).toMatchObject({
      eventId: "evt-1",
      tool: "claude-code",
      hookEvent: "PreToolUse",
      capturedAt: "2026-06-30T18:00:00Z",
      repo: "promptconduit/cli",
      branch: "main",
      subagentBadge: "",
      toolsSummary: "",
    });
  });

  it("retains the pretty-printed raw JSON (hook_event, raw_event, enrichments)", () => {
    const ev = parseStreamLine(
      envelope({ conversation_id: "tab-A", session_id: "sess-A" }, { prompt_id: "p9" }),
    );
    expect(ev?.rawJson).toBeDefined();
    expect(ev?.rawTruncated).toBe(false);
    const parsed = JSON.parse(ev!.rawJson!);
    expect(parsed.hook_event).toBe("beforeSubmitPrompt");
    expect(parsed.prompt_id).toBe("p9");
    expect(parsed.captured_at).toBe("2026-06-30T17:00:00Z");
    expect(parsed.raw_event.conversation_id).toBe("tab-A");
    expect(parsed.enrichments.vcs.repo).toBe("promptconduit/cli");
    // 2-space pretty printing, ready for the highlighter.
    expect(ev!.rawJson!).toContain('\n  "raw_event"');
  });

  it("truncates raw JSON at 32 KB and flags it", () => {
    const huge = envelope(
      { session_id: "s" },
      { raw_event: { session_id: "s", tool_response: "x".repeat(2 * RAW_JSON_MAX) } },
    );
    const ev = parseStreamLine(huge);
    expect(ev?.rawTruncated).toBe(true);
    expect(ev?.rawJson).toHaveLength(RAW_JSON_MAX);
    expect(ev?.rawJson).toContain('"hook_event"'); // the head survives
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

  it(`bounds each session buffer to ${MAX_EVENTS} events (drops oldest)`, () => {
    const s = new StreamState();
    for (let i = 0; i < 250; i++) {
      s.record(mk({ sessionKey: "A", hookEvent: `e${i}`, capturedAt: `2026-06-30T17:00:${String(i % 60).padStart(2, "0")}Z` }));
    }
    const buf = s.followedBuf();
    expect(buf?.events).toHaveLength(MAX_EVENTS);
    expect(buf?.events[0].hookEvent).toBe("e50"); // oldest 50 dropped
    expect(buf?.events[MAX_EVENTS - 1].hookEvent).toBe("e249");
  });

  it(`bounds the session count to ${MAX_SESSIONS} (evicts the least-recently-active)`, () => {
    const s = new StreamState();
    for (let i = 0; i < MAX_SESSIONS + 1; i++) {
      s.record(mk({ sessionKey: `s${i}`, capturedAt: `2026-06-30T17:${String(i).padStart(2, "0")}:00Z` }));
    }
    const list = s.listSessions();
    expect(list).toHaveLength(MAX_SESSIONS);
    expect(list.map((x) => x.key)).not.toContain("s0"); // oldest evicted whole
    expect(list.map((x) => x.key)).toContain(`s${MAX_SESSIONS}`);
    expect(s.followedKey).toBe(`s${MAX_SESSIONS}`);
  });

  it("evicting the pinned session drops the pin back to auto-follow", () => {
    const s = new StreamState();
    for (let i = 0; i < MAX_SESSIONS; i++) {
      s.record(mk({ sessionKey: `s${i}`, capturedAt: `2026-06-30T17:${String(i).padStart(2, "0")}:00Z` }));
    }
    s.pin("s0");
    expect(s.isPinned).toBe(true);
    s.record(mk({ sessionKey: "fresh", capturedAt: "2026-06-30T18:00:00Z" })); // evicts s0
    expect(s.isPinned).toBe(false);
    expect(s.followedKey).toBe("fresh");
  });

  it("enforces the per-session raw budget: oldest rawJson evicted, metadata kept", () => {
    const s = new StreamState();
    const chunk = 600_000; // 5 × 600 KB = 3 MB > 2 MB budget → the 2 oldest lose rawJson
    for (let i = 0; i < 5; i++) {
      s.record(
        mk({
          sessionKey: "A",
          eventId: `e${i}`,
          hookEvent: `hook-${i}`,
          rawJson: "x".repeat(chunk),
          capturedAt: `2026-06-30T17:00:0${i}Z`,
        }),
      );
    }
    const events = s.followedBuf()!.events;
    expect(events).toHaveLength(5);
    expect(events[0].rawJson).toBeUndefined();
    expect(events[1].rawJson).toBeUndefined();
    expect(events[2].rawJson).toBeDefined();
    expect(events[4].rawJson).toBeDefined();
    // Metadata survives eviction.
    expect(events[0].hookEvent).toBe("hook-0");
    const retained = events.reduce((n, e) => n + (e.rawJson?.length ?? 0), 0);
    expect(retained).toBeLessThanOrEqual(SESSION_RAW_BUDGET);
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

describe("buildStreamPanelState", () => {
  function fixtureState(pinKey?: string): StreamPanelState {
    const s = new StreamState();
    for (const line of sampleStreamLines) {
      const ev = parseStreamLine(line);
      if (ev) s.record(ev);
    }
    if (pinKey) s.pin(pinKey);
    return buildStreamPanelState(s, 7, false);
  }

  it("carries the followed session (newest activity → Cursor tab-B)", () => {
    const state = fixtureState();
    expect(state.revision).toBe(7);
    expect(state.pinned).toBe(false);
    expect(state.session).toMatchObject({
      key: "tab-B",
      tool: "cursor",
      keyIsConversationId: true,
      count: 2,
    });
    // Newest LAST in the buffer.
    expect(state.events.map((e) => e.hookEvent)).toEqual(["beforeSubmitPrompt", "afterAgentResponse"]);
  });

  it("reflects a pin and the Claude Code session-id identity", () => {
    const state = fixtureState("cc-1");
    expect(state.pinned).toBe(true);
    expect(state.session).toMatchObject({ key: "cc-1", keyIsConversationId: false });
    expect(state.events.map((e) => e.hookEvent)).toEqual(["UserPromptSubmit", "PreToolUse"]);
  });

  it("is empty (no session) before any event", () => {
    const state = buildStreamPanelState(new StreamState(), 1, false);
    expect(state.session).toBeUndefined();
    expect(state.events).toEqual([]);
  });
});

describe("renderStreamBody", () => {
  function renderFromFixtures(pinKey?: string): string {
    const s = new StreamState();
    for (const line of sampleStreamLines) {
      const ev = parseStreamLine(line);
      if (ev) s.record(ev);
    }
    if (pinKey) s.pin(pinKey);
    return renderStreamBody(buildStreamPanelState(s, 1, false));
  }

  it("renders only the followed session's events, newest first", () => {
    const html = renderFromFixtures();
    expect(html).toContain("afterAgentResponse"); // tab-B event
    expect(html).toContain("auto-following");
    expect(html).not.toContain("beforeShellExecution"); // tab-A only
    expect(html).not.toContain("PreToolUse"); // claude-code session cc-1 only
    // Newest row first in the markup.
    expect(html.indexOf("afterAgentResponse")).toBeLessThan(html.indexOf("beforeSubmitPrompt"));
  });

  it("shows the FULL session key with a copy button and the Cursor tab label", () => {
    const html = renderFromFixtures();
    expect(html).toContain('<code class="skey">tab-B</code>');
    expect(html).toContain("Copy id");
    expect(html).toContain("conversation_id (Cursor tab)");
  });

  it("labels a Claude Code session key as session_id", () => {
    const html = renderFromFixtures("cc-1");
    expect(html).toContain('<code class="skey">cc-1</code>');
    expect(html).toContain("session_id (Claude Code)");
    expect(html).toContain("📌 pinned");
    expect(html).toContain("Follow active");
    expect(html).not.toContain("afterAgentResponse"); // tab-B not shown while pinned to cc-1
  });

  it("renders rows expandable into highlighted raw JSON with a Copy JSON button", () => {
    const html = renderFromFixtures();
    expect(html).toMatch(/<details class="evt" data-exp="evt-\d+">/);
    expect(html).toContain('class="tape"');
    expect(html).toContain("Copy JSON");
    expect(html).toContain('<span class="j-key">&quot;hook_event&quot;</span>');
  });

  it("notes truncation and eviction with a pointer to events.jsonl", () => {
    const truncated = mk({ eventId: "t1", rawJson: '{"hook_event": "x"', rawTruncated: true });
    const evicted = mk({ eventId: "t2", rawJson: undefined });
    const html = renderStreamBody(stateFor({ key: "s", tool: "x", events: [truncated, evicted] }));
    expect(html).toContain("Truncated at 32&nbsp;KB");
    expect(html).toContain("Raw JSON evicted from memory");
    expect((html.match(/~\/\.promptconduit\/events\.jsonl/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("renders the toolbar with expand/collapse/pin/refresh controls", () => {
    const html = renderFromFixtures();
    expect(html).toContain('data-cmd="expandAll"');
    expect(html).toContain('data-cmd="collapseAll"');
    expect(html).toContain('data-cmd="pinSession"');
    expect(html).toContain('data-cmd="refresh"');
    expect(html).not.toContain('data-cmd="followActive"'); // only while pinned
  });

  it("renders an empty state when no session is followed", () => {
    const html = renderStreamBody(stateFor(undefined));
    expect(html).toContain("No sessions yet");
    expect(html).toContain("Live stream");
  });

  it("renders the log-disabled empty state", () => {
    const html = renderStreamBody({ ...stateFor(undefined), logDisabled: true });
    expect(html).toContain("PROMPTCONDUIT_EVENT_LOG=0");
  });

  it("shows repo @ branch from the vcs enrichment", () => {
    const buf = { key: "s", tool: "claude-code", events: [mk({ repo: "promptconduit/platform", branch: "main" })] };
    expect(renderStreamBody(stateFor(buf))).toContain("promptconduit/platform @ main");
  });

  it("escapes event fields, the session key, and raw JSON (injection payloads)", () => {
    const evil = mk({
      hookEvent: "<img src=x onerror=alert(1)>",
      tool: "<script>",
      repo: "<script>",
      eventId: '"><script>alert(2)</script>',
      rawJson: '{\n  "prompt": "<script>alert(3)</script>"\n}',
    });
    const html = renderStreamBody(stateFor({ key: '"><script>alert(4)</script>', tool: "<script>", events: [evil] }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("shortId", () => {
  it("keeps short keys verbatim and tails long ones", () => {
    expect(shortId("abc")).toBe("abc");
    expect(shortId("0123456789abcdef0123")).toBe("…cdef0123");
  });
});

describe("stream enrichment badges (via parseStreamLine)", () => {
  it("reads subagent badge and tools summary from enrichment slugs", () => {
    const subStart = parseStreamLine(sampleEnrichmentLines[0]);
    expect(subStart?.subagentBadge).toBe("Explore start");
    const tools = parseStreamLine(sampleEnrichmentLines[4]);
    expect(tools?.toolsSummary).toBe("3 tools · 1 failed");
  });
});
