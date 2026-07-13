import { describe, it, expect } from "vitest";
import {
  parseStreamLine,
  StreamState,
  buildStreamPanelState,
  shortId,
  MAX_EVENTS,
  MAX_SESSIONS,
  MAX_UNIFIED_ROWS,
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

// A drilled ("session" mode) panel state carrying one session's events.
function sessionState(buf: {
  key: string;
  tool: string;
  keyIsConversationId?: boolean;
  events: StreamEvent[];
}): StreamPanelState {
  return {
    revision: 1,
    viewMode: "session",
    logDisabled: false,
    sessionCount: 1,
    session: {
      key: buf.key,
      tool: buf.tool,
      keyIsConversationId: buf.keyIsConversationId ?? false,
      count: buf.events.length,
    },
    events: buf.events,
  };
}

// A unified ("all" mode) panel state carrying interleaved events, no session.
function allState(events: StreamEvent[], sessionCount = 1): StreamPanelState {
  return { revision: 1, viewMode: "all", logDisabled: false, sessionCount, session: undefined, events };
}

// An empty unified state (nothing has streamed yet).
function emptyState(): StreamPanelState {
  return { revision: 1, viewMode: "all", logDisabled: false, sessionCount: 0, session: undefined, events: [] };
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

describe("StreamState unified feed + drill-down", () => {
  it("defaults to the unified view with no drilled session", () => {
    const s = new StreamState();
    expect(s.viewMode).toBe("all");
    expect(s.drilledBuf()).toBeUndefined();
    expect(s.sessionCount).toBe(0);
    expect(s.allEntries()).toEqual([]);
    expect(s.listSessions()).toEqual([]);
  });

  it("interleaves every session's events newest-last by timestamp", () => {
    const s = new StreamState();
    s.record(mk({ sessionKey: "A", hookEvent: "a1", capturedAt: "2026-06-30T17:00:00Z" }));
    s.record(mk({ sessionKey: "B", hookEvent: "b1", capturedAt: "2026-06-30T17:05:00Z" }));
    s.record(mk({ sessionKey: "A", hookEvent: "a2", capturedAt: "2026-06-30T17:10:00Z" }));
    expect(s.allEntries().map((e) => e.hookEvent)).toEqual(["a1", "b1", "a2"]);
    expect(s.sessionCount).toBe(2);
  });

  it("does NOT let a busier session steal the view (no auto-follow)", () => {
    const s = new StreamState();
    // A quiet Cursor agent submits once, then a chatty Claude Code session fires 20 events.
    s.record(mk({ sessionKey: "cursor-tab", tool: "cursor", hookEvent: "beforeSubmitPrompt", capturedAt: "2026-06-30T17:00:00Z" }));
    for (let i = 0; i < 20; i++) {
      s.record(mk({ sessionKey: "cc", tool: "claude-code", hookEvent: `PreToolUse${i}`, capturedAt: `2026-06-30T17:0${Math.floor(i / 10)}:${String(i % 60).padStart(2, "0")}Z` }));
    }
    // The view stays unified; the Cursor event is still present, not evicted or hidden.
    expect(s.viewMode).toBe("all");
    const keys = s.allEntries().map((e) => e.sessionKey);
    expect(keys).toContain("cursor-tab");
    expect(keys).toContain("cc");
  });

  it("tie-breaks identical timestamps by ingest order (stable interleave)", () => {
    const s = new StreamState();
    s.record(mk({ sessionKey: "A", hookEvent: "a", capturedAt: "2026-06-30T17:00:00Z" }));
    s.record(mk({ sessionKey: "B", hookEvent: "b", capturedAt: "2026-06-30T17:00:00Z" }));
    // Same instant → first-recorded is older (appears first); newest is LAST.
    expect(s.allEntries().map((e) => e.sessionKey)).toEqual(["A", "B"]);
  });

  it("caps the unified feed at MAX_UNIFIED_ROWS (keeps the newest)", () => {
    const s = new StreamState();
    // 3 sessions × 200 events = 600 total, all retained per-session (MAX_EVENTS=200).
    for (let sess = 0; sess < 3; sess++) {
      for (let i = 0; i < MAX_EVENTS; i++) {
        s.record(mk({ sessionKey: `s${sess}`, hookEvent: `e${sess}-${i}`, capturedAt: `2026-06-30T${String(17 + sess).padStart(2, "0")}:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z` }));
      }
    }
    const entries = s.allEntries();
    expect(entries).toHaveLength(MAX_UNIFIED_ROWS);
    // The newest event overall survives the cap (it's last).
    expect(entries[entries.length - 1].hookEvent).toBe(`e2-${MAX_EVENTS - 1}`);
  });

  it("honors an explicit row limit on allEntries", () => {
    const s = new StreamState();
    s.record(mk({ sessionKey: "A", hookEvent: "a1", capturedAt: "2026-06-30T17:00:00Z" }));
    s.record(mk({ sessionKey: "B", hookEvent: "b1", capturedAt: "2026-06-30T17:05:00Z" }));
    s.record(mk({ sessionKey: "A", hookEvent: "a2", capturedAt: "2026-06-30T17:10:00Z" }));
    expect(s.allEntries(2).map((e) => e.hookEvent)).toEqual(["b1", "a2"]); // 2 newest
  });

  it("drills into one session and returns to the unified view", () => {
    const s = new StreamState();
    s.record(mk({ sessionKey: "A", hookEvent: "A-evt", capturedAt: "2026-06-30T17:00:00Z" }));
    s.record(mk({ sessionKey: "B", hookEvent: "B-evt", capturedAt: "2026-06-30T17:05:00Z" }));
    s.drillIn("A");
    expect(s.viewMode).toBe("session");
    const buf = s.drilledBuf();
    expect(buf?.key).toBe("A");
    expect(buf?.events.map((e) => e.hookEvent)).toEqual(["A-evt"]);
    s.showAll();
    expect(s.viewMode).toBe("all");
    expect(s.drilledBuf()).toBeUndefined();
  });

  it("ignores a drill into a session it has never seen (stays unified)", () => {
    const s = new StreamState();
    s.record(mk({ sessionKey: "A", capturedAt: "2026-06-30T17:00:00Z" }));
    s.drillIn("ghost");
    expect(s.viewMode).toBe("all");
    expect(s.drilledBuf()).toBeUndefined();
  });

  it("falls back to the unified view when the drilled session is evicted", () => {
    const s = new StreamState();
    for (let i = 0; i < MAX_SESSIONS; i++) {
      s.record(mk({ sessionKey: `s${i}`, capturedAt: `2026-06-30T17:${String(i).padStart(2, "0")}:00Z` }));
    }
    s.drillIn("s0");
    expect(s.viewMode).toBe("session");
    s.record(mk({ sessionKey: "fresh", capturedAt: "2026-06-30T18:00:00Z" })); // evicts s0
    expect(s.viewMode).toBe("all");
    expect(s.drilledBuf()).toBeUndefined();
  });

  it(`bounds each session buffer to ${MAX_EVENTS} events (drops oldest)`, () => {
    const s = new StreamState();
    for (let i = 0; i < 250; i++) {
      s.record(mk({ sessionKey: "A", hookEvent: `e${i}`, capturedAt: `2026-06-30T17:00:${String(i % 60).padStart(2, "0")}Z` }));
    }
    s.drillIn("A");
    const buf = s.drilledBuf();
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
    expect(s.sessionCount).toBe(MAX_SESSIONS);
    expect(list.map((x) => x.key)).not.toContain("s0"); // oldest evicted whole
    expect(list.map((x) => x.key)).toContain(`s${MAX_SESSIONS}`);
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
    s.drillIn("A");
    const events = s.drilledBuf()!.events;
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
});

describe("buildStreamPanelState", () => {
  function fixtureState(drillKey?: string): StreamPanelState {
    const s = new StreamState();
    for (const line of sampleStreamLines) {
      const ev = parseStreamLine(line);
      if (ev) s.record(ev);
    }
    if (drillKey) s.drillIn(drillKey);
    return buildStreamPanelState(s, 7, false);
  }

  it("defaults to the unified feed carrying every session interleaved", () => {
    const state = fixtureState();
    expect(state.revision).toBe(7);
    expect(state.viewMode).toBe("all");
    expect(state.session).toBeUndefined();
    expect(state.sessionCount).toBe(3); // tab-A, cc-1, tab-B
    expect(state.events).toHaveLength(6);
    // Newest LAST, across all sessions (tab-B's afterAgentResponse @17:01:20).
    const last = state.events[state.events.length - 1];
    expect(last.hookEvent).toBe("afterAgentResponse");
    expect(last.sessionKey).toBe("tab-B");
    // Every session is represented — the feed does not collapse to one.
    const keys = new Set(state.events.map((e) => e.sessionKey));
    expect(keys).toEqual(new Set(["tab-A", "cc-1", "tab-B"]));
  });

  it("drilling in carries only that session and its Claude Code identity", () => {
    const state = fixtureState("cc-1");
    expect(state.viewMode).toBe("session");
    expect(state.session).toMatchObject({ key: "cc-1", keyIsConversationId: false });
    expect(state.events.map((e) => e.hookEvent)).toEqual(["UserPromptSubmit", "PreToolUse"]);
  });

  it("is an empty unified feed before any event", () => {
    const state = buildStreamPanelState(new StreamState(), 1, false);
    expect(state.viewMode).toBe("all");
    expect(state.session).toBeUndefined();
    expect(state.sessionCount).toBe(0);
    expect(state.events).toEqual([]);
  });
});

describe("renderStreamBody", () => {
  function renderFromFixtures(drillKey?: string): string {
    const s = new StreamState();
    for (const line of sampleStreamLines) {
      const ev = parseStreamLine(line);
      if (ev) s.record(ev);
    }
    if (drillKey) s.drillIn(drillKey);
    return renderStreamBody(buildStreamPanelState(s, 1, false));
  }

  it("renders the unified feed: all sessions interleaved, newest first, with drill badges", () => {
    const html = renderFromFixtures();
    expect(html).toContain("All activity");
    expect(html).toContain("3 live sessions");
    expect(html).toContain("Showing all activity");
    // Every session's events are shown — no collapse to one tool.
    expect(html).toContain("afterAgentResponse"); // tab-B (cursor)
    expect(html).toContain("beforeShellExecution"); // tab-A (cursor)
    expect(html).toContain("PreToolUse"); // cc-1 (claude-code)
    // Clickable, tool-tagged session badges.
    expect(html).toContain('data-drill="tab-B"');
    expect(html).toContain('data-tool="cursor"');
    expect(html).toContain('data-drill="cc-1"');
    expect(html).toContain('data-tool="claude-code"');
    // Newest row first in the markup (tab-B afterAgentResponse leads).
    expect(html.indexOf("afterAgentResponse")).toBeLessThan(html.indexOf("beforeShellExecution"));
    // No stale follow/pin copy.
    expect(html).not.toContain("auto-following");
    expect(html).not.toContain("📌 pinned");
  });

  it("drilling in renders only that session's events with its identity", () => {
    const html = renderFromFixtures("cc-1");
    expect(html).toContain('<code class="skey">cc-1</code>');
    expect(html).toContain("session_id (Claude Code)");
    expect(html).toContain("Copy id");
    expect(html).toContain("Drilled into one session");
    expect(html).toContain("PreToolUse");
    expect(html).not.toContain("afterAgentResponse"); // tab-B not shown while drilled into cc-1
  });

  it("labels a drilled Cursor tab session key as conversation_id", () => {
    const html = renderFromFixtures("tab-B");
    expect(html).toContain('<code class="skey">tab-B</code>');
    expect(html).toContain("conversation_id (Cursor tab)");
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
    const html = renderStreamBody(sessionState({ key: "s", tool: "x", events: [truncated, evicted] }));
    expect(html).toContain("Truncated at 32&nbsp;KB");
    expect(html).toContain("Raw JSON evicted from memory");
    expect((html.match(/~\/\.promptconduit\/events\.jsonl/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("unified toolbar: expand/collapse/drill/refresh, no back button", () => {
    const html = renderFromFixtures();
    expect(html).toContain('data-cmd="expandAll"');
    expect(html).toContain('data-cmd="collapseAll"');
    expect(html).toContain('data-cmd="drillIn"');
    expect(html).toContain('data-cmd="refresh"');
    expect(html).not.toContain('data-cmd="showAll"'); // back appears only when drilled
  });

  it("drilled toolbar: a back-to-all-activity button, no drill button", () => {
    const html = renderFromFixtures("cc-1");
    expect(html).toContain('data-cmd="showAll"');
    expect(html).toContain("← All activity");
    expect(html).not.toContain('data-cmd="drillIn"');
  });

  it("renders an empty unified state before any activity", () => {
    const html = renderStreamBody(emptyState());
    expect(html).toContain("No activity yet");
    expect(html).toContain("All activity");
  });

  it("renders the log-disabled empty state", () => {
    const html = renderStreamBody({ ...emptyState(), logDisabled: true });
    expect(html).toContain("PROMPTCONDUIT_EVENT_LOG=0");
  });

  it("shows repo @ branch from the vcs enrichment", () => {
    const buf = { key: "s", tool: "claude-code", events: [mk({ repo: "promptconduit/platform", branch: "main" })] };
    expect(renderStreamBody(sessionState(buf))).toContain("promptconduit/platform @ main");
  });

  it("escapes event fields, the session key, and raw JSON (injection payloads)", () => {
    const evil = mk({
      hookEvent: "<img src=x onerror=alert(1)>",
      tool: "<script>",
      repo: "<script>",
      eventId: '"><script>alert(2)</script>',
      rawJson: '{\n  "prompt": "<script>alert(3)</script>"\n}',
    });
    const html = renderStreamBody(sessionState({ key: '"><script>alert(4)</script>', tool: "<script>", events: [evil] }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes the session key and tool in unified-feed drill badges", () => {
    const evil = mk({ sessionKey: '"><script>alert(5)</script>', tool: "<script>", eventId: "b1" });
    const html = renderStreamBody(allState([evil], 1));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("data-drill=");
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
