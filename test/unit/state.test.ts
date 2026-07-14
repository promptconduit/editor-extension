import { describe, it, expect, vi, afterEach } from "vitest";
import { ConversationStore, ACTIVE_KEY_DEBOUNCE_MS, LATCH_TTL_MS, MAX_RECENT_REQUESTS } from "../../src/state";
import { parseEnvelopeV2 } from "../../src/envelope";
import { sampleEnrichmentLines, v2Envelope } from "../../dev/fixtures";
import { sampleEvents } from "../../dev/fixtures";
import type { CostEvent } from "../../src/types";

// Record a prompt-submit envelope (the latch signal). Cursor keys by
// conversation_id, Claude Code by session_id.
function promptEnv(
  store: ConversationStore,
  tool: "cursor" | "claude-code",
  hookEvent: string,
  key: string,
  ts: string,
): void {
  const opts =
    tool === "cursor"
      ? { sessionId: `sess-${key}`, raw: { conversation_id: key } }
      : { sessionId: key };
  const env = parseEnvelopeV2(v2Envelope(tool, hookEvent, ts, opts));
  if (env) store.recordEnvelope(env);
}

function mkEvent(p: Partial<CostEvent>): CostEvent {
  return {
    tool: "cursor", session_id: "s", request_id: "r",
    ts: "2026-06-27T17:00:00Z", model: "m", model_priced: true, source: "exact",
    cwd_base: "x",
    tokens: { input: 1, output: 1, cache_read: 1, cache_write: 0 },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0.01, currency: "USD" },
    ...p,
  };
}

describe("ConversationStore.key", () => {
  it("prefers conversation_id, falls back to session_id", () => {
    expect(ConversationStore.key({ conversation_id: "c1", session_id: "s1" })).toBe("c1");
    expect(ConversationStore.key({ conversation_id: "", session_id: "s1" })).toBe("s1");
    expect(ConversationStore.key({ session_id: "s1" })).toBe("s1");
  });
});

describe("ConversationStore active-conversation tracking", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("follows the most-recently-active tab by timestamp", () => {
    vi.useFakeTimers();
    const store = new ConversationStore();
    sampleEvents.forEach((e) => store.recordEvent(e));
    vi.advanceTimersByTime(ACTIVE_KEY_DEBOUNCE_MS);
    expect(store.activeKey).toBe("tab-B");
    expect(store.activeLastEvent?.request_id).toBe("b1");
  });

  it("switches active when an older tab produces a newer record", () => {
    vi.useFakeTimers();
    const store = new ConversationStore();
    store.recordEvent(mkEvent({ conversation_id: "A", request_id: "a1", ts: "2026-06-27T17:00:00Z" }));
    store.recordEvent(mkEvent({ conversation_id: "B", request_id: "b1", ts: "2026-06-27T17:05:00Z" }));
    vi.advanceTimersByTime(ACTIVE_KEY_DEBOUNCE_MS);
    expect(store.activeKey).toBe("B");
    store.recordEvent(mkEvent({ conversation_id: "A", request_id: "a2", ts: "2026-06-27T17:10:00Z" }));
    vi.advanceTimersByTime(ACTIVE_KEY_DEBOUNCE_MS);
    expect(store.activeKey).toBe("A");
  });

  it("dedups recent turns by request_id (replace, not append)", () => {
    const store = new ConversationStore();
    store.recordEvent(mkEvent({ conversation_id: "A", request_id: "dup", ts: "2026-06-27T17:00:00Z", cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0.01, currency: "USD" } }));
    store.recordEvent(mkEvent({ conversation_id: "A", request_id: "dup", ts: "2026-06-27T17:00:01Z", cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0.99, currency: "USD" } }));
    expect(store.activeRecent).toHaveLength(1);
    expect(store.activeRecent[0].cost.total).toBe(0.99); // replaced with the latest
  });

  it("retains full recent history (oldest-first, uncapped)", () => {
    const store = new ConversationStore();
    for (let i = 0; i < 60; i++) {
      store.recordEvent(mkEvent({ conversation_id: "A", request_id: `r${i}`, ts: `2026-06-27T17:${String(i).padStart(2, "0")}:00Z` }));
    }
    const recent = store.activeRecent;
    expect(recent).toHaveLength(60); // every request preserved — nothing dropped
    expect(recent[0].request_id).toBe("r0"); // oldest still present
    expect(recent[recent.length - 1].request_id).toBe("r59"); // newest
  });

  it("accumulates the active summary locally from cost events", () => {
    const store = new ConversationStore();
    store.recordEvent(mkEvent({
      conversation_id: "A", request_id: "a1", ts: "2026-06-27T17:00:00Z",
      model: "claude-opus-4-8",
      tokens: { input: 100, output: 50, cache_read: 1000, cache_write: 200 },
      cost: { input: 0.01, output: 0.02, cache_read: 0.005, cache_write: 0.003, total: 0.038, currency: "USD" },
      tools: { total: 3, by_name: { Read: 2, Bash: 1 } },
    }));
    store.recordEvent(mkEvent({
      conversation_id: "A", request_id: "a2", ts: "2026-06-27T17:05:00Z",
      model: "claude-haiku-4-5",
      tokens: { input: 10, output: 5, cache_read: 0, cache_write: 0 },
      cost: { input: 0.001, output: 0.002, cache_read: 0, cache_write: 0, total: 0.003, currency: "USD" },
      tools: { total: 1, by_name: { Edit: 1 } },
    }));

    const s = store.activeSummary!;
    expect(s.totals.cost_total).toBeCloseTo(0.041, 6);
    expect(s.totals.input).toBe(110);
    expect(s.totals.cache_read).toBe(1000);
    expect(s.by_model).toHaveLength(2);
    expect(s.by_model[0].model).toBe("claude-opus-4-8"); // costliest first
    expect(s.tools).toEqual({ total: 4, by_name: { Read: 2, Bash: 1, Edit: 1 } });
    expect(s.started_at).toBe("2026-06-27T17:00:00Z");
    expect(s.updated_at).toBe("2026-06-27T17:05:00Z");
    // Session signals recomputed from summed tokens.
    expect(s.signals?.cache_hit_rate).toBeCloseTo(1000 / (1000 + 200 + 110), 6);
    expect(s.signals?.tier).toBe("premium"); // dominant (costliest) model's tier
    expect(s.signals?.tool_calls).toBe(4);
  });

  it("does not double-count a request delivered twice (Cursor stop + afterAgentResponse)", () => {
    const store = new ConversationStore();
    const twice = mkEvent({
      conversation_id: "A", request_id: "dup", ts: "2026-06-27T17:00:00Z",
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0.5, currency: "USD" },
    });
    store.recordEvent(twice);
    store.recordEvent({ ...twice, ts: "2026-06-27T17:00:01Z" });
    expect(store.activeSummary?.totals.cost_total).toBeCloseTo(0.5, 6);
  });

  it("lists every conversation, most-recently-active first, for the panel", () => {
    const store = new ConversationStore();
    store.recordEvent(mkEvent({ tool: "claude-code", session_id: "cc-1", conversation_id: undefined, request_id: "c1", ts: "2026-06-27T17:00:00Z" }));
    store.recordEvent(mkEvent({ tool: "cursor", conversation_id: "tab-B", request_id: "b1", ts: "2026-06-27T17:05:00Z" }));
    const list = store.list();
    expect(list.map((c) => c.key)).toEqual(["tab-B", "cc-1"]);
    expect(list[0].tool).toBe("cursor");
    expect(list[1].tool).toBe("claude-code");
    expect(list[1].summary.totals.cost_total).toBeCloseTo(0.01, 6);
  });

  it("starts empty", () => {
    const store = new ConversationStore();
    expect(store.activeKey).toBeUndefined();
    expect(store.displayKey).toBeUndefined();
    expect(store.activeLastEvent).toBeUndefined();
    expect(store.activeRecent).toEqual([]);
    expect(store.list()).toEqual([]);
  });
});

describe("ConversationStore displayKey precedence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("prefers pinned over a focused terminal and activity", () => {
    const store = new ConversationStore();
    store.recordEvent(mkEvent({ conversation_id: "A", request_id: "a1", ts: "2026-06-27T17:00:00Z" }));
    store.recordEvent(mkEvent({ conversation_id: "B", request_id: "b1", ts: "2026-06-27T17:05:00Z" }));
    store.recordEvent(mkEvent({ conversation_id: "C", request_id: "c1", ts: "2026-06-27T17:01:00Z" }));
    store.setPinnedKey("A");
    store.setFocusedKey("C");
    // Pin is explicit intent — it now wins over a focused terminal.
    expect(store.displayKey).toBe("A");
    expect(store.focusSource).toBe("pinned");
  });

  it("uses pinned when no terminal focus", () => {
    const store = new ConversationStore();
    store.recordEvent(mkEvent({ conversation_id: "A", request_id: "a1", ts: "2026-06-27T17:00:00Z" }));
    store.recordEvent(mkEvent({ conversation_id: "B", request_id: "b1", ts: "2026-06-27T17:05:00Z" }));
    store.setPinnedKey("A");
    expect(store.displayKey).toBe("A");
    expect(store.focusSource).toBe("pinned");
  });

  it("falls back to active when no focus or pin", () => {
    vi.useFakeTimers();
    const store = new ConversationStore();
    store.recordEvent(mkEvent({ conversation_id: "A", request_id: "a1", ts: "2026-06-27T17:00:00Z" }));
    store.recordEvent(mkEvent({ conversation_id: "B", request_id: "b1", ts: "2026-06-27T17:05:00Z" }));
    vi.advanceTimersByTime(ACTIVE_KEY_DEBOUNCE_MS);
    expect(store.displayKey).toBe("B");
    expect(store.focusSource).toBe("activity");
  });
});

describe("ConversationStore prompt latch (last prompted wins)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("latches a Cursor prompt and holds it through a Claude Code event burst", () => {
    vi.useFakeTimers();
    const store = new ConversationStore();
    promptEnv(store, "cursor", "beforeSubmitPrompt", "cur-tab", "2026-06-27T17:00:00Z");
    expect(store.displayKey).toBe("cur-tab");
    expect(store.focusSource).toBe("prompted");
    // A chatty Claude Code session fires 20 events and becomes the ACTIVE session…
    for (let i = 0; i < 20; i++) {
      store.recordEvent(
        mkEvent({ session_id: "cc", request_id: `r${i}`, ts: `2026-06-27T18:00:${String(i % 60).padStart(2, "0")}Z`, tool: "claude-code" }),
      );
    }
    vi.advanceTimersByTime(ACTIVE_KEY_DEBOUNCE_MS);
    expect(store.activeKey).toBe("cc"); // …confirmed active…
    expect(store.displayKey).toBe("cur-tab"); // …but the latch still wins.
  });

  it("re-latches to a Claude Code prompt over an earlier Cursor prompt", () => {
    const store = new ConversationStore();
    promptEnv(store, "cursor", "beforeSubmitPrompt", "cur-tab", "2026-06-27T17:00:00Z");
    promptEnv(store, "claude-code", "UserPromptSubmit", "cc", "2026-06-27T17:05:00Z");
    expect(store.displayKey).toBe("cc");
    expect(store.focusSource).toBe("prompted");
  });

  it("re-latches to a focused terminal over a prior prompt (most recent signal wins)", () => {
    const store = new ConversationStore();
    promptEnv(store, "cursor", "beforeSubmitPrompt", "cur-tab", "2026-06-27T17:00:00Z");
    store.recordEvent(mkEvent({ session_id: "cc", request_id: "r1", ts: "2026-06-27T17:01:00Z", tool: "claude-code" }));
    store.setFocusedKey("cc");
    expect(store.displayKey).toBe("cc");
    expect(store.focusSource).toBe("terminal");
  });

  it("latches to a selected Cursor agent tab over a prior prompt (most recent signal wins)", () => {
    const store = new ConversationStore();
    promptEnv(store, "claude-code", "UserPromptSubmit", "cc", "2026-06-27T17:00:00Z");
    store.recordEvent(mkEvent({ conversation_id: "cur-tab", request_id: "r1", ts: "2026-06-27T17:01:00Z", tool: "cursor" }));
    store.setCursorTabKey("cur-tab");
    expect(store.displayKey).toBe("cur-tab");
    expect(store.focusSource).toBe("cursor-tab");
    // Undefined (no tab focused / record unreadable) never clears the latch.
    store.setCursorTabKey(undefined);
    expect(store.displayKey).toBe("cur-tab");
  });

  it("a cursor-tab latch for a session with no events falls through to activity", () => {
    const store = new ConversationStore();
    store.recordEvent(mkEvent({ session_id: "cc", request_id: "r1", ts: "2026-06-27T17:00:00Z", tool: "claude-code" }));
    store.setCursorTabKey("never-streamed");
    expect(store.displayKey).toBe("cc");
    expect(store.focusSource).toBe("activity");
  });

  it("lets a pin override the latch", () => {
    const store = new ConversationStore();
    promptEnv(store, "cursor", "beforeSubmitPrompt", "cur-tab", "2026-06-27T17:00:00Z");
    store.recordEvent(mkEvent({ conversation_id: "pinme", request_id: "p1", ts: "2026-06-27T17:02:00Z" }));
    store.setPinnedKey("pinme");
    expect(store.displayKey).toBe("pinme");
    expect(store.focusSource).toBe("pinned");
  });

  it("expires the latch after the TTL, falling back to activity", () => {
    vi.useFakeTimers();
    const store = new ConversationStore();
    promptEnv(store, "cursor", "beforeSubmitPrompt", "cur-tab", "2026-06-27T17:00:00Z");
    store.recordEvent(mkEvent({ session_id: "cc", request_id: "r1", ts: "2026-06-27T18:00:00Z", tool: "claude-code" }));
    vi.advanceTimersByTime(ACTIVE_KEY_DEBOUNCE_MS);
    expect(store.activeKey).toBe("cc");
    expect(store.displayKey).toBe("cur-tab"); // latch still fresh
    vi.advanceTimersByTime(LATCH_TTL_MS + 1);
    expect(store.displayKey).toBe("cc"); // latch expired → activity
    expect(store.focusSource).toBe("activity");
  });
});

describe("ConversationStore active debounce", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces flips between different conversations", () => {
    vi.useFakeTimers();
    const store = new ConversationStore();
    store.recordEvent(mkEvent({ conversation_id: "A", request_id: "a1", ts: "2026-06-27T17:00:00Z" }));
    expect(store.activeKey).toBe("A");
    store.recordEvent(mkEvent({ conversation_id: "B", request_id: "b1", ts: "2026-06-27T17:05:00Z" }));
    expect(store.activeKey).toBe("A");
    vi.advanceTimersByTime(ACTIVE_KEY_DEBOUNCE_MS);
    expect(store.activeKey).toBe("B");
  });
});

describe("ConversationStore enrichment slugs", () => {
  it("accumulates diff and subagent stats from envelopes", () => {
    const store = new ConversationStore();
    for (const line of sampleEnrichmentLines) {
      const env = parseEnvelopeV2(line);
      if (env) {
        store.recordEnvelope(env);
      }
    }
    const view = store.viewForKey("cc-enrich");
    expect(view?.diff).toMatchObject({ files_changed: 3, insertions: 120, deletions: 40 });
    expect(view?.subagents).toMatchObject({
      count: 2,
      totalDurationMs: 190000,
      totalUsd: 0.31,
      dominantType: "Explore",
    });
  });
});

describe("ConversationStore enrichment dedup (rotation re-ingest)", () => {
  it("does not double-count subagents or diff when the same lines re-ingest", () => {
    const store = new ConversationStore();
    for (let pass = 0; pass < 2; pass++) {
      for (const line of sampleEnrichmentLines) {
        const env = parseEnvelopeV2(line);
        if (env) {
          store.recordEnvelope(env);
        }
      }
    }
    const view = store.viewForKey("cc-enrich");
    expect(view?.subagents).toMatchObject({
      count: 2,
      totalDurationMs: 190000,
      totalUsd: 0.31,
    });
  });
});

describe("ConversationStore activity units", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets a session with unparseable timestamps become active and sort newest", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:00:00Z"));
    const store = new ConversationStore();
    store.recordEvent(mkEvent({ conversation_id: "timed", request_id: "t1", ts: "2026-07-06T11:00:00Z" }));
    vi.advanceTimersByTime(ACTIVE_KEY_DEBOUNCE_MS);
    // A later event whose ts is garbage must still count as newest activity.
    store.recordEvent(mkEvent({ conversation_id: "untimed", request_id: "u1", ts: "not-a-date" }));
    vi.advanceTimersByTime(ACTIVE_KEY_DEBOUNCE_MS);
    expect(store.activeKey).toBe("untimed");
    const list = store.list();
    expect(list[0]?.key).toBe("untimed");
    // Same units as epoch-ms timestamps, not a bare counter.
    expect(list[0]?.lastActivity).toBeGreaterThan(1e12);
  });
});

describe("ConversationStore focused-key guard", () => {
  it("falls back while the focused session has no events, then takes over", () => {
    const store = new ConversationStore();
    store.recordEvent(mkEvent({ conversation_id: "real", request_id: "r1" }));
    store.setFocusedKey("ghost");
    expect(store.displayKey).toBe("real");
    expect(store.focusSource).toBe("activity");
    store.recordEvent(mkEvent({ conversation_id: "ghost", request_id: "g1", ts: "2026-06-27T18:00:00Z" }));
    expect(store.displayKey).toBe("ghost");
    expect(store.focusSource).toBe("terminal");
  });
});

describe("ConversationStore recent cap", () => {
  it("caps the retained list but keeps totals exact", () => {
    const store = new ConversationStore();
    for (let i = 0; i < MAX_RECENT_REQUESTS + 5; i++) {
      store.recordEvent(mkEvent({ conversation_id: "big", request_id: `r${i}` }));
    }
    const view = store.viewForKey("big");
    expect(view?.recent).toHaveLength(MAX_RECENT_REQUESTS);
    expect(view?.droppedRequests).toBe(5);
    // mkEvent contributes 1 input token per request — totals count every request.
    expect(view?.summary.totals.input).toBe(MAX_RECENT_REQUESTS + 5);
  });
});

describe("ConversationStore dispose", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cancels the pending active-key debounce", () => {
    vi.useFakeTimers();
    const store = new ConversationStore();
    let fired = 0;
    store.setOnActiveDebounced(() => {
      fired += 1;
    });
    store.recordEvent(mkEvent({ conversation_id: "A", request_id: "a1", ts: "2026-06-27T17:00:00Z" }));
    store.recordEvent(mkEvent({ conversation_id: "B", request_id: "b1", ts: "2026-06-27T17:05:00Z" }));
    store.dispose();
    vi.advanceTimersByTime(ACTIVE_KEY_DEBOUNCE_MS * 2);
    expect(fired).toBe(0);
  });
});
