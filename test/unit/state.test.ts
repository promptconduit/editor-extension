import { describe, it, expect } from "vitest";
import { ConversationStore } from "../../src/state";
import { sampleEvents } from "../../dev/fixtures";
import type { CostEvent } from "../../src/types";

function mkEvent(p: Partial<CostEvent>): CostEvent {
  return {
    v: 2, kind: "cost_event", tool: "cursor", session_id: "s", request_id: "r",
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

  it("exposes the active summary", () => {
    const store = new ConversationStore();
    store.recordEvent(mkEvent({ conversation_id: "A", request_id: "a1", ts: "2026-06-27T17:00:00Z" }));
    store.recordSummary({
      v: 2, kind: "session_summary", session_id: "sA", tool: "cursor", source: "exact",
      conversation_id: "A", started_at: "2026-06-27T16:00:00Z", updated_at: "2026-06-27T17:09:00Z",
      totals: { input: 1, output: 1, cache_read: 1, cache_write: 0, cost_total: 0.5, currency: "USD" },
      by_model: [],
    } as any);
    expect(store.activeSummary?.totals.cost_total).toBe(0.5);
  });

  it("starts empty", () => {
    const store = new ConversationStore();
    expect(store.activeKey).toBeUndefined();
    expect(store.activeLastEvent).toBeUndefined();
    expect(store.activeRecent).toEqual([]);
  });
});
