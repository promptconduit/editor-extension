import { describe, it, expect } from "vitest";
import { parseEnvelopeV2 } from "../../src/envelope";
import { SessionTreeStore, LIVE_WINDOW_MS } from "../../src/graphPanel/sessionTree";
import { costEnvelope, costRequest, v2Envelope } from "../../dev/fixtures";

// Feed raw events.jsonl lines through the same parse → ingest path the live
// controller uses.
function ingest(store: SessionTreeStore, lines: string[]): void {
  for (const line of lines) {
    const env = parseEnvelopeV2(line);
    if (env) store.ingest(env);
  }
}

const T0 = "2026-07-06T17:00:00Z";
const NOW = Date.parse("2026-07-06T17:02:00Z"); // 2 min after T0 → session is live

// A full captured turn with tools, a paired subagent, and cost on Stop.
function turnLines(session: string, pid: string): string[] {
  return [
    v2Envelope("claude-code", "UserPromptSubmit", T0, {
      sessionId: session,
      promptId: pid,
      raw: { prompt: "add a live session graph to the extension", model: "claude-opus-4-8" },
      enrichments: { prompt: { count: 1, chars: 42, words: 8 } },
    }),
    v2Envelope("claude-code", "PostToolBatch", "2026-07-06T17:00:10Z", {
      sessionId: session,
      promptId: pid,
      enrichments: {
        tools: {
          total: 3,
          failed: 1,
          calls: [
            { name: "Read", ok: true },
            { name: "Read", ok: true },
            { name: "Edit", ok: false },
          ],
        },
      },
    }),
    v2Envelope("claude-code", "SubagentStart", "2026-07-06T17:00:15Z", {
      sessionId: session,
      promptId: pid,
      raw: { agent_id: "a1", agent_type: "Explore" },
      enrichments: { subagent: { agent_id: "a1", agent_type: "Explore", phase: "start", concurrent: 1 } },
    }),
    v2Envelope("claude-code", "SubagentStop", "2026-07-06T17:00:55Z", {
      sessionId: session,
      promptId: pid,
      raw: { agent_id: "a1" },
      enrichments: {
        subagent: {
          agent_id: "a1",
          agent_type: "Explore",
          phase: "stop",
          duration_ms: 40000,
          model: "claude-sonnet-5",
          usd: { total: 0.12, currency: "USD" },
        },
      },
    }),
    costEnvelope(
      "claude-code",
      "2026-07-06T17:01:00Z",
      session,
      [costRequest({ request_id: `${pid}-r1`, usd: { total: 0.3, currency: "USD" } })],
      { promptId: pid, enrichments: { turn: { duration_ms: 60000, prompt_id: pid } } },
    ),
  ];
}

describe("SessionTreeStore happy path", () => {
  it("builds session → turn → tools + subagent with cost and states", () => {
    const store = new SessionTreeStore();
    ingest(store, turnLines("cc-g", "p1"));

    const snap = store.snapshot(undefined, NOW);
    expect(snap.selectedKey).toBe("cc-g");
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0]).toMatchObject({ key: "cc-g", tool: "claude-code", live: true, turnCount: 1 });

    const s = snap.session!;
    expect(s.repo).toBe("promptconduit/editor-extension");
    expect(s.branch).toBe("main");
    expect(s.model).toBe("claude-opus-4-8");
    expect(s.live).toBe(true);
    expect(s.ended).toBe(false);
    expect(s.droppedTurns).toBe(0);

    expect(s.turns).toHaveLength(1);
    const t = s.turns[0];
    expect(t.kind).toBe("prompt");
    expect(t.promptText).toBe("add a live session graph to the extension");
    expect(t.state).toBe("completed"); // closed by the Stop
    expect(t.durationMs).toBe(60000);
    expect(t.tools.total).toBe(3);
    expect(t.tools.failed).toBe(1);
    expect(t.tools.top).toEqual([
      { name: "Read", count: 2, failed: 0 },
      { name: "Edit", count: 1, failed: 1 },
    ]);

    expect(t.subagents).toHaveLength(1);
    expect(t.subagents[0]).toMatchObject({
      agentId: "a1",
      agentType: "Explore",
      state: "completed",
      durationMs: 40000,
      usdTotal: 0.12,
      model: "claude-sonnet-5",
    });

    // Turn cost = lead request + subagent; session cost = its turns.
    expect(t.usdTotal).toBeCloseTo(0.42);
    expect(s.usdTotal).toBeCloseTo(0.42);
  });
});

describe("SessionTreeStore running states", () => {
  it("marks an open turn and an unstopped subagent running while the session is live", () => {
    const store = new SessionTreeStore();
    ingest(store, [
      v2Envelope("claude-code", "UserPromptSubmit", T0, {
        sessionId: "cc-run",
        promptId: "p1",
        raw: { prompt: "long task" },
      }),
      v2Envelope("claude-code", "SubagentStart", "2026-07-06T17:00:15Z", {
        sessionId: "cc-run",
        promptId: "p1",
        raw: { agent_id: "a1", agent_type: "Explore" },
        enrichments: { subagent: { agent_id: "a1", agent_type: "Explore", phase: "start" } },
      }),
    ]);

    const t = store.snapshot(undefined, NOW).session!.turns[0];
    expect(t.state).toBe("running");
    expect(t.subagents[0].state).toBe("running");
  });

  it("never pulses a stale open turn once the session went idle", () => {
    const store = new SessionTreeStore();
    ingest(store, [
      v2Envelope("claude-code", "UserPromptSubmit", T0, {
        sessionId: "cc-stale",
        promptId: "p1",
        raw: { prompt: "abandoned" },
      }),
    ]);

    const later = Date.parse(T0) + LIVE_WINDOW_MS + 1000;
    const snap = store.snapshot(undefined, later);
    expect(snap.session!.live).toBe(false);
    expect(snap.session!.turns[0].state).toBe("completed");
  });

  it("SessionEnd ends the session even within the live window", () => {
    const store = new SessionTreeStore();
    ingest(store, [
      v2Envelope("claude-code", "UserPromptSubmit", T0, {
        sessionId: "cc-end",
        promptId: "p1",
        raw: { prompt: "quick one" },
      }),
      v2Envelope("claude-code", "SessionEnd", "2026-07-06T17:00:30Z", { sessionId: "cc-end" }),
    ]);
    const snap = store.snapshot(undefined, NOW);
    expect(snap.session!.ended).toBe(true);
    expect(snap.session!.live).toBe(false);
    expect(snap.sessions[0].live).toBe(false);
  });
});

describe("SessionTreeStore failure and interrupt states", () => {
  it("StopFailure → failed turn", () => {
    const store = new SessionTreeStore();
    ingest(store, [
      v2Envelope("claude-code", "UserPromptSubmit", T0, {
        sessionId: "cc-fail",
        promptId: "p1",
        raw: { prompt: "doomed" },
      }),
      v2Envelope("claude-code", "StopFailure", "2026-07-06T17:00:20Z", {
        sessionId: "cc-fail",
        enrichments: { turn: { prompt_id: "p1" } },
      }),
    ]);
    expect(store.snapshot(undefined, NOW).session!.turns[0].state).toBe("failed");
  });

  it("a prompt arriving mid-turn marks the previous turn interrupted", () => {
    const store = new SessionTreeStore();
    ingest(store, [
      v2Envelope("claude-code", "UserPromptSubmit", T0, {
        sessionId: "cc-int",
        promptId: "p1",
        raw: { prompt: "first" },
      }),
      v2Envelope("claude-code", "UserPromptSubmit", "2026-07-06T17:00:30Z", {
        sessionId: "cc-int",
        promptId: "p2",
        raw: { prompt: "wait, do this instead" },
        enrichments: { prompt: { count: 2, is_interrupt: true } },
      }),
    ]);
    const turns = store.snapshot(undefined, NOW).session!.turns;
    expect(turns.map((t) => t.state)).toEqual(["interrupted", "running"]);
  });

  it("marks a subagent failed when its Task tool call reported ok:false", () => {
    const store = new SessionTreeStore();
    ingest(store, [
      v2Envelope("claude-code", "UserPromptSubmit", T0, {
        sessionId: "cc-sf",
        promptId: "p1",
        raw: { prompt: "fan out" },
      }),
      v2Envelope("claude-code", "PostToolBatch", "2026-07-06T17:00:10Z", {
        sessionId: "cc-sf",
        promptId: "p1",
        enrichments: {
          tools: { total: 1, failed: 1, calls: [{ name: "Agent", ok: false, agent_type: "Explore" }] },
        },
      }),
      v2Envelope("claude-code", "SubagentStart", "2026-07-06T17:00:05Z", {
        sessionId: "cc-sf",
        promptId: "p1",
        raw: { agent_id: "a1", agent_type: "Explore" },
        enrichments: { subagent: { agent_id: "a1", agent_type: "Explore", phase: "start" } },
      }),
      v2Envelope("claude-code", "SubagentStop", "2026-07-06T17:00:20Z", {
        sessionId: "cc-sf",
        promptId: "p1",
        raw: { agent_id: "a1" },
        enrichments: { subagent: { agent_id: "a1", agent_type: "Explore", phase: "stop" } },
      }),
    ]);
    expect(store.snapshot(undefined, NOW).session!.turns[0].subagents[0].state).toBe("failed");
  });
});

describe("SessionTreeStore worktree badges", () => {
  it("badges a subagent running in a different worktree than the session", () => {
    const store = new SessionTreeStore();
    ingest(store, [
      // Session base: NOT a worktree (first envelope latches the base).
      v2Envelope("claude-code", "UserPromptSubmit", T0, {
        sessionId: "cc-wt",
        promptId: "p1",
        raw: { prompt: "parallel fix" },
      }),
      v2Envelope("claude-code", "SubagentStart", "2026-07-06T17:00:05Z", {
        sessionId: "cc-wt",
        promptId: "p1",
        raw: { agent_id: "a1", agent_type: "claude" },
        worktree: true, // vcs.worktree = { is_worktree: true, path: "/worktrees/x" }
        enrichments: { subagent: { agent_id: "a1", agent_type: "claude", phase: "start" } },
      }),
    ]);
    const t = store.snapshot(undefined, NOW).session!.turns[0];
    expect(t.subagents[0].worktreeBadge).toBe(true);
    expect(t.subagents[0].worktreePath).toBe("/worktrees/x");
  });

  it("a session started inside a worktree shows it on the root, not as badges", () => {
    const store = new SessionTreeStore();
    ingest(store, [
      v2Envelope("claude-code", "UserPromptSubmit", T0, {
        sessionId: "cc-base",
        promptId: "p1",
        raw: { prompt: "inside the worktree" },
        worktree: true,
      }),
    ]);
    const s = store.snapshot(undefined, NOW).session!;
    expect(s.worktreePath).toBe("/worktrees/x");
    expect(s.turns[0].worktreeBadge).toBeUndefined(); // same worktree as base
  });
});

describe("SessionTreeStore picker and selection", () => {
  it("orders sessions newest-activity first and defaults to the live one", () => {
    const store = new SessionTreeStore();
    ingest(store, [
      // Old, ended session.
      v2Envelope("claude-code", "UserPromptSubmit", "2026-07-06T10:00:00Z", {
        sessionId: "cc-old",
        promptId: "p1",
        raw: { prompt: "yesterday's work" },
      }),
      v2Envelope("claude-code", "SessionEnd", "2026-07-06T10:30:00Z", { sessionId: "cc-old" }),
      // Fresh, live session.
      v2Envelope("claude-code", "UserPromptSubmit", "2026-07-06T17:01:00Z", {
        sessionId: "cc-new",
        promptId: "p2",
        raw: { prompt: "current work" },
      }),
    ]);
    const snap = store.snapshot(undefined, NOW);
    expect(snap.sessions.map((s) => s.key)).toEqual(["cc-new", "cc-old"]);
    expect(snap.selectedKey).toBe("cc-new");
  });

  it("honors an explicit selection and falls back when it is unknown", () => {
    const store = new SessionTreeStore();
    ingest(store, turnLines("cc-a", "p1"));
    expect(store.snapshot("cc-a", NOW).selectedKey).toBe("cc-a");
    expect(store.snapshot("nope", NOW).selectedKey).toBe("cc-a");
  });

  it("interleaved sessions keep their turns separate", () => {
    const store = new SessionTreeStore();
    ingest(store, [
      v2Envelope("claude-code", "UserPromptSubmit", T0, {
        sessionId: "cc-x",
        promptId: "px",
        raw: { prompt: "session x" },
      }),
      v2Envelope("cursor", "beforeSubmitPrompt", "2026-07-06T17:00:05Z", {
        sessionId: "sess-y",
        raw: { conversation_id: "tab-y" },
      }),
      v2Envelope("claude-code", "PostToolUse", "2026-07-06T17:00:10Z", {
        sessionId: "cc-x",
        promptId: "px",
        enrichments: { tools: { total: 1, calls: [{ name: "Bash", ok: true }] } },
      }),
    ]);
    const snap = store.snapshot("cc-x", NOW);
    expect(snap.sessions).toHaveLength(2);
    expect(snap.session!.turns[0].tools.total).toBe(1);
  });

  it("returns no session when nothing has been ingested", () => {
    const store = new SessionTreeStore();
    const snap = store.snapshot(undefined, NOW);
    expect(snap.sessions).toEqual([]);
    expect(snap.session).toBeUndefined();
    expect(snap.selectedKey).toBeUndefined();
  });

  it("skips malformed lines without breaking the stream", () => {
    const store = new SessionTreeStore();
    ingest(store, ["not json", "{}", JSON.stringify({ schema: 1, hook_event: "Stop" })]);
    ingest(store, turnLines("cc-ok", "p1"));
    expect(store.snapshot(undefined, NOW).sessions).toHaveLength(1);
  });
});
