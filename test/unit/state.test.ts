import { describe, it, expect } from "vitest";
import { ConversationStore } from "../../src/state";
import { sampleEvents } from "../../dev/fixtures";
import type { CostEvent } from "../../src/types";

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
  it("follows the most-recently-active tab by timestamp", () => {
    const store = new ConversationStore();
    sampleEvents.forEach((e) => store.recordEvent(e)); // tab-A (older) then tab-B (newer)
    expect(store.activeKey).toBe("tab-B");
    expect(store.activeLastEvent?.request_id).toBe("b1");
  });

  it("switches active when an older tab produces a newer record", () => {
    const store = new ConversationStore();
    store.recordEvent(mkEvent({ conversation_id: "A", request_id: "a1", ts: "2026-06-27T17:00:00Z" }));
    store.recordEvent(mkEvent({ conversation_id: "B", request_id: "b1", ts: "2026-06-27T17:05:00Z" }));
    expect(store.activeKey).toBe("B");
    store.recordEvent(mkEvent({ conversation_id: "A", request_id: "a2", ts: "2026-06-27T17:10:00Z" }));
    expect(store.activeKey).toBe("A");
  });

  it("dedups recent turns by request_id (replace, not append)", () => {
    const store = new ConversationStore();
    store.recordEvent(mkEvent({ conversation_id: "A", request_id: "dup", ts: "2026-06-27T17:00:00Z", cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0.01, currency: "USD" } }));
    store.recordEvent(mkEvent({ conversation_id: "A", request_id: "dup", ts: "2026-06-27T17:00:01Z", cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0.99, currency: "USD" } }));
    expect(store.activeRecent).toHaveLength(1);
    expect(store.activeRecent[0].cost.total).toBe(0.99); // replaced with the latest
  });

  it("bounds recent history (oldest-first, capped)", () => {
    const store = new ConversationStore();
    for (let i = 0; i < 60; i++) {
      store.recordEvent(mkEvent({ conversation_id: "A", request_id: `r${i}`, ts: `2026-06-27T17:${String(i).padStart(2, "0")}:00Z` }));
    }
    const recent = store.activeRecent;
    expect(recent).toHaveLength(50); // MAX_RECENT
    expect(recent[0].request_id).toBe("r10"); // oldest retained
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
    expect(store.activeLastEvent).toBeUndefined();
    expect(store.activeRecent).toEqual([]);
    expect(store.list()).toEqual([]);
  });
});
