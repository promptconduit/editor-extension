import { describe, it, expect } from "vitest";
import { costEventsFrom, parseEnvelopeV2 } from "../../src/envelope";
import { PromptGroupStore, PromptGroup } from "../../src/promptGroup";
import { costEnvelope, costRequest, v2Envelope } from "../../dev/fixtures";

// Feed raw events.jsonl lines through the same parse → record path the
// extension uses (costEvents derived per envelope, exactly like the caller).
function ingest(store: PromptGroupStore, lines: string[]): void {
  for (const line of lines) {
    const env = parseEnvelopeV2(line);
    if (env) store.record(env, costEventsFrom(env));
  }
}

function toolsSlug(...names: string[]): Record<string, unknown> {
  return {
    tools: { total: names.length, calls: names.map((name) => ({ name, ok: true })) },
  };
}

// A full captured turn: prompt → tools → Stop with cost, all sharing prompt_id.
function happyPathLines(session: string, pid: string): string[] {
  return [
    v2Envelope("claude-code", "UserPromptSubmit", "2026-07-06T17:00:00Z", {
      sessionId: session,
      promptId: pid,
      raw: { prompt: "add tests for the parser", permission_mode: "auto" },
      enrichments: { prompt: { count: 1, chars: 24, words: 5 } },
    }),
    v2Envelope("claude-code", "PostToolUse", "2026-07-06T17:00:05Z", {
      sessionId: session,
      promptId: pid,
      raw: { tool_name: "Read" },
      enrichments: toolsSlug("Read"),
    }),
    v2Envelope("claude-code", "PostToolBatch", "2026-07-06T17:00:10Z", {
      sessionId: session,
      promptId: pid,
      enrichments: {
        tools: {
          total: 2,
          failed: 1,
          calls: [
            { name: "Bash", ok: true, duration_ms: 1500 },
            { name: "Edit", ok: false },
          ],
        },
      },
    }),
    costEnvelope(
      "claude-code",
      "2026-07-06T17:00:30Z",
      session,
      [costRequest({ request_id: `${pid}-r1` }), costRequest({ request_id: `${pid}-r2`, model: "claude-opus-4-8" })],
      { promptId: pid, enrichments: { turn: { duration_ms: 30000, prompt_id: pid } } },
    ),
  ];
}

describe("PromptGroupStore happy path", () => {
  it("correlates prompt, tools, and Stop cost into one group", () => {
    const store = new PromptGroupStore();
    ingest(store, happyPathLines("cc-h", "p1"));

    const groups = store.groupsFor("cc-h");
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.id).toBe("p1");
    expect(g.kind).toBe("prompt");
    expect(g.promptText).toBe("add tests for the parser");
    expect(g.permissionMode).toBe("auto");
    expect(g.promptStats).toMatchObject({ chars: 24, words: 5 });
    expect(g.startedAt).toBe("2026-07-06T17:00:00Z");
    expect(g.endedAt).toBe("2026-07-06T17:00:30Z");
    expect(g.turnDurationMs).toBe(30000);
    expect(g.interrupted).toBeUndefined();

    expect(g.toolCalls.map((c) => c.name)).toEqual(["Read", "Bash", "Edit"]);
    expect(g.toolCalls[1]).toMatchObject({ ok: true, durationMs: 1500 });
    expect(g.toolCalls[2].ok).toBe(false);

    expect(g.requests.map((r) => r.request_id)).toEqual(["p1-r1", "p1-r2"]);
    expect(g.requests[1].model).toBe("claude-opus-4-8");

    // Every routed envelope left a raw event, in arrival order.
    expect(g.rawEvents).toHaveLength(4);
    expect(g.rawEvents.map((r) => r.hookEvent)).toEqual([
      "UserPromptSubmit",
      "PostToolUse",
      "PostToolBatch",
      "Stop",
    ]);
    for (const re of g.rawEvents) {
      expect(re.truncated).toBe(false);
      expect(re.evicted).toBe(false);
      expect(JSON.parse(re.json!)).toMatchObject({ captured_at: expect.any(String) });
    }
    expect(store.droppedFor("cc-h")).toBe(0);
  });

  it("routes pid-carrying tool events to their prompt even after a newer prompt opened", () => {
    const store = new PromptGroupStore();
    ingest(store, [
      v2Envelope("claude-code", "UserPromptSubmit", "2026-07-06T17:00:00Z", {
        sessionId: "cc-pid",
        promptId: "p1",
        raw: { prompt: "first" },
      }),
      v2Envelope("claude-code", "UserPromptSubmit", "2026-07-06T17:00:10Z", {
        sessionId: "cc-pid",
        promptId: "p2",
        raw: { prompt: "second" },
      }),
      // Straggler from the first turn, tagged with its prompt_id.
      v2Envelope("claude-code", "PostToolUse", "2026-07-06T17:00:12Z", {
        sessionId: "cc-pid",
        promptId: "p1",
        enrichments: toolsSlug("Bash"),
      }),
    ]);
    const [g1, g2] = store.groupsFor("cc-pid");
    expect(g1.id).toBe("p1");
    expect(g1.toolCalls.map((c) => c.name)).toEqual(["Bash"]);
    expect(g2.id).toBe("p2");
    expect(g2.toolCalls).toHaveLength(0);
  });

  it("synthesizes a group id from the event id when prompt_id is missing", () => {
    const store = new PromptGroupStore();
    ingest(store, [
      v2Envelope("claude-code", "UserPromptSubmit", "2026-07-06T17:00:00Z", {
        sessionId: "cc-nopid",
        raw: { prompt: "hello" },
      }),
    ]);
    const groups = store.groupsFor("cc-nopid");
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toMatch(/^t:evt-/);
    expect(groups[0].kind).toBe("prompt");
  });
});

describe("PromptGroupStore interruption", () => {
  it("closes the open group as interrupted when the next prompt is an interrupt", () => {
    const store = new PromptGroupStore();
    ingest(store, [
      v2Envelope("claude-code", "UserPromptSubmit", "2026-07-06T17:00:00Z", {
        sessionId: "cc-int",
        promptId: "p1",
        raw: { prompt: "do the thing" },
      }),
      v2Envelope("claude-code", "UserPromptSubmit", "2026-07-06T17:00:20Z", {
        sessionId: "cc-int",
        promptId: "p2",
        raw: { prompt: "wait, also handle the empty case" },
        enrichments: { prompt: { count: 2, chars: 32, words: 7, is_interrupt: true } },
      }),
    ]);
    const [g1, g2] = store.groupsFor("cc-int");
    expect(g1.interrupted).toBe(true);
    expect(g1.endedAt).toBe("2026-07-06T17:00:20Z");
    expect(g2.interrupted).toBeUndefined();
  });

  it("closes the open group without the interrupted flag on a plain follow-up prompt", () => {
    const store = new PromptGroupStore();
    ingest(store, [
      v2Envelope("claude-code", "UserPromptSubmit", "2026-07-06T17:00:00Z", {
        sessionId: "cc-noint",
        promptId: "p1",
        raw: { prompt: "one" },
      }),
      v2Envelope("claude-code", "UserPromptSubmit", "2026-07-06T17:00:20Z", {
        sessionId: "cc-noint",
        promptId: "p2",
        raw: { prompt: "two" },
      }),
    ]);
    const [g1] = store.groupsFor("cc-noint");
    expect(g1.interrupted).toBeUndefined();
    expect(g1.endedAt).toBe("2026-07-06T17:00:20Z");
  });
});

describe("PromptGroupStore Cursor path", () => {
  it("opens one 'uncaptured' group per prompt-less Stop (Cursor's normal path)", () => {
    const store = new PromptGroupStore();
    ingest(store, [
      costEnvelope("cursor", "2026-07-06T17:00:00Z", "cur-1", [costRequest({ request_id: "gen-1" })]),
      costEnvelope("cursor", "2026-07-06T17:01:00Z", "cur-1", [costRequest({ request_id: "gen-2" })]),
    ]);
    const groups = store.groupsFor("cur-1");
    expect(groups).toHaveLength(2);
    for (const g of groups) {
      expect(g.kind).toBe("uncaptured");
      expect(g.id).toMatch(/^r:evt-/);
      expect(g.requests).toHaveLength(1);
      expect(g.endedAt).toBeTruthy();
    }
    expect(groups[0].requests[0].request_id).toBe("gen-1");
    expect(groups[1].requests[0].request_id).toBe("gen-2");
  });

  it("dedups cost requests by request_id within a group", () => {
    const store = new PromptGroupStore();
    ingest(store, [
      v2Envelope("claude-code", "UserPromptSubmit", "2026-07-06T17:00:00Z", {
        sessionId: "cc-dupreq",
        promptId: "p1",
        raw: { prompt: "x" },
      }),
      costEnvelope("claude-code", "2026-07-06T17:00:10Z", "cc-dupreq", [costRequest({ request_id: "dup" })], {
        promptId: "p1",
      }),
      costEnvelope("claude-code", "2026-07-06T17:00:20Z", "cc-dupreq", [costRequest({ request_id: "dup" })], {
        promptId: "p1",
      }),
    ]);
    const [g] = store.groupsFor("cc-dupreq");
    expect(g.requests).toHaveLength(1);
  });
});

describe("PromptGroupStore trailing and preamble routing", () => {
  it("attaches a tool event within 30s of the last close to that group", () => {
    const store = new PromptGroupStore();
    ingest(store, [
      v2Envelope("claude-code", "UserPromptSubmit", "2026-07-06T17:00:00Z", {
        sessionId: "cc-trail",
        raw: { prompt: "x" },
      }),
      v2Envelope("claude-code", "Stop", "2026-07-06T17:00:30Z", { sessionId: "cc-trail" }),
      // 10s after the Stop, no prompt_id → still the closed group's work.
      v2Envelope("claude-code", "PostToolUse", "2026-07-06T17:00:40Z", {
        sessionId: "cc-trail",
        enrichments: toolsSlug("Write"),
      }),
    ]);
    const groups = store.groupsFor("cc-trail");
    expect(groups).toHaveLength(1);
    expect(groups[0].toolCalls.map((c) => c.name)).toEqual(["Write"]);
  });

  it("routes a tool event past the 30s window to the preamble group instead", () => {
    const store = new PromptGroupStore();
    ingest(store, [
      v2Envelope("claude-code", "UserPromptSubmit", "2026-07-06T17:00:00Z", {
        sessionId: "cc-late",
        raw: { prompt: "x" },
      }),
      v2Envelope("claude-code", "Stop", "2026-07-06T17:00:30Z", { sessionId: "cc-late" }),
      v2Envelope("claude-code", "PostToolUse", "2026-07-06T17:01:30Z", {
        sessionId: "cc-late",
        enrichments: toolsSlug("Write"),
      }),
    ]);
    const groups = store.groupsFor("cc-late");
    expect(groups).toHaveLength(2);
    expect(groups[0].toolCalls).toHaveLength(0);
    expect(groups[1].kind).toBe("preamble");
    expect(groups[1].id).toBe("pre:cc-late");
    expect(groups[1].toolCalls.map((c) => c.name)).toEqual(["Write"]);
  });

  it("collects events before the first prompt into ONE preamble group", () => {
    const store = new PromptGroupStore();
    ingest(store, [
      v2Envelope("claude-code", "PostToolUse", "2026-07-06T17:00:00Z", {
        sessionId: "cc-pre",
        enrichments: toolsSlug("Read"),
      }),
      v2Envelope("claude-code", "PostToolUse", "2026-07-06T17:00:05Z", {
        sessionId: "cc-pre",
        enrichments: toolsSlug("Bash"),
      }),
    ]);
    const groups = store.groupsFor("cc-pre");
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("preamble");
    expect(groups[0].toolCalls.map((c) => c.name)).toEqual(["Read", "Bash"]);
    expect(groups[0].rawEvents).toHaveLength(2);
  });
});

describe("PromptGroupStore subagents", () => {
  it("pairs SubagentStart with its SubagentStop by agent_id", () => {
    const store = new PromptGroupStore();
    ingest(store, [
      v2Envelope("claude-code", "UserPromptSubmit", "2026-07-06T17:00:00Z", {
        sessionId: "cc-sub",
        promptId: "p1",
        raw: { prompt: "explore" },
      }),
      v2Envelope("claude-code", "SubagentStart", "2026-07-06T17:00:05Z", {
        sessionId: "cc-sub",
        promptId: "p1",
        raw: { agent_id: "a1", agent_type: "Explore" },
        enrichments: { subagent: { agent_id: "a1", agent_type: "Explore", phase: "start", concurrent: 2 } },
      }),
      v2Envelope("claude-code", "SubagentStop", "2026-07-06T17:01:40Z", {
        sessionId: "cc-sub",
        promptId: "p1",
        raw: { agent_id: "a1" },
        enrichments: {
          subagent: {
            agent_id: "a1",
            agent_type: "Explore",
            phase: "stop",
            duration_ms: 95000,
            requests: 3,
            model: "claude-opus-4-8",
            tokens: { input: 100, output: 50, cache_read: 1000, cache_write: 20 },
            usd: { total: 0.18, currency: "USD" },
          },
        },
      }),
    ]);
    const [g] = store.groupsFor("cc-sub");
    expect(g.subagents).toHaveLength(1);
    expect(g.subagents[0]).toMatchObject({
      agentId: "a1",
      agentType: "Explore",
      startedAt: "2026-07-06T17:00:05Z",
      endedAt: "2026-07-06T17:01:40Z",
      concurrent: 2,
      durationMs: 95000,
      requests: 3,
      model: "claude-opus-4-8",
      usdTotal: 0.18,
    });
    expect(g.subagents[0].tokens).toEqual({ input: 100, output: 50, cache_read: 1000, cache_write: 20 });
    expect(g.subagents[0].orphanStop).toBeUndefined();
  });

  it("records an orphan SubagentStop with a back-computed startedAt", () => {
    const store = new PromptGroupStore();
    ingest(store, [
      v2Envelope("claude-code", "UserPromptSubmit", "2026-07-06T17:00:00Z", {
        sessionId: "cc-orphan",
        promptId: "p1",
        raw: { prompt: "x" },
      }),
      v2Envelope("claude-code", "SubagentStop", "2026-07-06T17:05:00Z", {
        sessionId: "cc-orphan",
        promptId: "p1",
        raw: { agent_id: "a9" },
        enrichments: {
          subagent: { agent_id: "a9", agent_type: "Explore", phase: "stop", duration_ms: 60000 },
        },
      }),
    ]);
    const [g] = store.groupsFor("cc-orphan");
    expect(g.subagents).toHaveLength(1);
    expect(g.subagents[0].orphanStop).toBe(true);
    expect(g.subagents[0].startedAt).toBe("2026-07-06T17:04:00.000Z");
    expect(g.subagents[0].endedAt).toBe("2026-07-06T17:05:00Z");
    expect(g.subagents[0].durationMs).toBe(60000);
  });
});

describe("PromptGroupStore idempotence (dedup)", () => {
  it("re-ingesting the same lines changes nothing (log rotation re-read)", () => {
    const store = new PromptGroupStore();
    const lines = happyPathLines("cc-dedup", "p1");
    ingest(store, lines);

    const snapshot = (g: PromptGroup) => ({
      rev: g.rev,
      toolCalls: g.toolCalls.length,
      requests: g.requests.length,
      rawEvents: g.rawEvents.length,
      endedAt: g.endedAt,
    });
    const before = store.groupsFor("cc-dedup").map(snapshot);

    ingest(store, lines); // identical bytes → identical event_ids → all deduped
    const after = store.groupsFor("cc-dedup").map(snapshot);
    expect(after).toEqual(before);
    expect(store.groupsFor("cc-dedup")).toHaveLength(1);
    expect(store.droppedFor("cc-dedup")).toBe(0);
  });
});

describe("PromptGroupStore raw JSON limits", () => {
  it("truncates a raw event's JSON at 32KB and marks it truncated", () => {
    const store = new PromptGroupStore();
    ingest(store, [
      v2Envelope("claude-code", "PostToolUse", "2026-07-06T17:00:00Z", {
        sessionId: "cc-big",
        raw: { tool_name: "Read", tool_response: "x".repeat(40_000) },
        enrichments: toolsSlug("Read"),
      }),
    ]);
    const [g] = store.groupsFor("cc-big");
    expect(g.rawEvents).toHaveLength(1);
    expect(g.rawEvents[0].truncated).toBe(true);
    expect(g.rawEvents[0].json!.length).toBe(32 * 1024);
    expect(g.rawEvents[0].evicted).toBe(false);
    // Metadata survives regardless.
    expect(g.rawEvents[0].hookEvent).toBe("PostToolUse");
    expect(g.rawEvents[0].eventId).toMatch(/^evt-/);
  });

  it("keeps small raw events untouched", () => {
    const store = new PromptGroupStore();
    ingest(store, [
      v2Envelope("claude-code", "PostToolUse", "2026-07-06T17:00:00Z", {
        sessionId: "cc-small",
        raw: { tool_name: "Read" },
        enrichments: toolsSlug("Read"),
      }),
    ]);
    const [g] = store.groupsFor("cc-small");
    expect(g.rawEvents[0].truncated).toBe(false);
    expect(JSON.parse(g.rawEvents[0].json!).hook_event).toBe("PostToolUse");
  });
});

describe("PromptGroupStore group cap", () => {
  it("evicts the oldest groups past 300 per conversation and counts them", () => {
    const store = new PromptGroupStore();
    const lines: string[] = [];
    for (let i = 0; i < 305; i++) {
      lines.push(
        costEnvelope("cursor", `2026-07-06T17:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`, "cur-cap", [
          costRequest({ request_id: `gen-${i}` }),
        ]),
      );
    }
    ingest(store, lines);
    const groups = store.groupsFor("cur-cap");
    expect(groups).toHaveLength(300);
    expect(store.droppedFor("cur-cap")).toBe(5);
    // The 5 oldest are gone; the 6th event's group is now first.
    expect(groups[0].requests[0].request_id).toBe("gen-5");
    expect(groups[299].requests[0].request_id).toBe("gen-304");
  });
});

describe("PromptGroupStore rev", () => {
  it("bumps rev on every mutation of a group", () => {
    const store = new PromptGroupStore();
    ingest(store, [
      v2Envelope("claude-code", "UserPromptSubmit", "2026-07-06T17:00:00Z", {
        sessionId: "cc-rev",
        promptId: "p1",
        raw: { prompt: "x" },
      }),
    ]);
    const [g] = store.groupsFor("cc-rev");
    const afterPrompt = g.rev;
    expect(afterPrompt).toBeGreaterThan(0);

    ingest(store, [
      v2Envelope("claude-code", "PostToolUse", "2026-07-06T17:00:05Z", {
        sessionId: "cc-rev",
        promptId: "p1",
        enrichments: toolsSlug("Bash"),
      }),
    ]);
    const afterTool = g.rev;
    expect(afterTool).toBeGreaterThan(afterPrompt);

    ingest(store, [
      costEnvelope("claude-code", "2026-07-06T17:00:30Z", "cc-rev", [costRequest({ request_id: "r1" })], {
        promptId: "p1",
      }),
    ]);
    expect(g.rev).toBeGreaterThan(afterTool);
  });
});
