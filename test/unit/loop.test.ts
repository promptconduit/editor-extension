import { describe, it, expect } from "vitest";
import { costEventsFrom, parseEnvelopeV2 } from "../../src/envelope";
import { PromptGroupStore } from "../../src/promptGroup";
import { buildAdvice, buildLedger, collapsedRoundTrips } from "../../src/loop/ledger";
import { classifyTask } from "../../src/loop/taskKind";
import { compareHistory } from "../../src/loop/history";
import { costEnvelope, v2Envelope } from "../../dev/fixtures";
import { S, lines, req } from "../fixtures/blogPrompt";

function store(): PromptGroupStore {
  const s = new PromptGroupStore({ retainRaw: false });
  for (const l of lines()) {
    const env = parseEnvelopeV2(l);
    if (env) s.record(env, costEventsFrom(env));
  }
  return s;
}

const group = (id: string) => store().groupsFor(S).find((g) => g.id === id)!;

describe("prompt attribution", () => {
  it("counts each tool once despite PostToolUse + PostToolBatch", () => {
    const g = group("p-blog");
    expect(g.toolCalls).toHaveLength(8);
    expect(g.toolCalls[1].durationMs).toBe(300396);
  });

  it("moves calls to the prompt they ran in", () => {
    const s = store();
    const byId = new Map(s.groupsFor(S).map((g) => [g.id, g]));
    expect(byId.get("p-ci")!.requests.map((r) => r.request_id)).toEqual(["r0"]);
    expect(byId.get("p-blog")!.requests.map((r) => r.request_id)).toEqual([
      "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9",
    ]);
    expect(byId.get("p-blog")!.afterPromptRequestIds).toEqual(["r9"]);
    expect(byId.get("p-next")!.requests.map((r) => r.request_id)).toEqual(["r10"]);
  });

  it("classifies task kinds, letting short follow-ups inherit", () => {
    const s = store();
    const kinds = s.groupsFor(S).map((g) => g.taskKind);
    expect(kinds).toEqual(["review", "ship", "ship"]);
  });
});

describe("ledger", () => {
  const ledger = buildLedger(group("p-blog"))!;

  it("splits the cost into re-read, new context and output", () => {
    expect(ledger.roundTrips).toBe(8);
    const inPrompt = ledger.calls.filter((c) => !c.afterPrompt).reduce((a, c) => a + c.usd.total, 0);
    expect(inPrompt).toBeCloseTo(0.699, 3);
    expect(ledger.totals.usd).toBeCloseTo(0.699 + 0.1678, 3);
    expect(ledger.totals.reread / ledger.totals.usd).toBeGreaterThan(0.8);
    expect(ledger.cacheTtl).toBe("1h");
    expect(ledger.longestGapAfterCall).toBe(1);
  });

  it("attaches tools to the call that asked for them", () => {
    const names = ledger.calls.map((c) => c.tools.map((t) => t.name).join("+"));
    expect(names).toEqual([
      "Bash", "Bash", "TaskStop+Bash", "Bash", "Bash", "ToolSearch", "mcp__bing-webmaster__submit_url", "", "",
    ]);
    expect(collapsedRoundTrips(ledger.calls.filter((c) => !c.afterPrompt))).toBe(4);
  });

  it("re-prices the same steps under other approaches", () => {
    const advice = buildAdvice(ledger, { firstCallUsd: 0.342, firstCallContext: 69182 });
    const byId = new Map(advice.map((a) => [a.id, a]));
    expect(byId.get("fewer-round-trips")!.usdIfApplied).toBeCloseTo(0.35, 2);
    expect(byId.get("fresh-session")!.usdIfApplied).toBeCloseTo(0.51, 1);
    // Switching models mid-session re-caches everything: costs more, not less.
    expect(byId.get("avoid-model-switch")!.usdIfApplied).toBeGreaterThan(2);
    expect(byId.get("avoid-model-switch")!.deltaUsd).toBeGreaterThan(0);
    expect(byId.get("cache-expiry")!.usdIfApplied).toBeCloseTo(1.95, 1);
    expect(byId.get("after-prompt-wake")!.usdIfApplied).toBeCloseTo(0.168, 2);
    // Options first, cheapest first.
    expect(advice[0].id).toBe("fewer-round-trips");
  });
});

describe("taskKind", () => {
  it.each([
    ["publish the blog post", "ship"],
    ["merge it", "ship"],
    ["yes cut v0.36.0 and add the changelog", "ship"],
    ["why is CI failing on main", "debug"],
    ["draft the launch post", "docs"],
    ["build the CLI team spend nudge", "build"],
    ["how does the tail reader work", "explore"],
  ])("%s → %s", (text, kind) => {
    expect(classifyTask(text)).toBe(kind);
  });
  it("inherits for follow-ups only when given a previous kind", () => {
    expect(classifyTask("yes please", "ship")).toBe("ship");
    expect(classifyTask("yes please")).toBe("other");
  });
});

describe("history", () => {
  it("compares with past prompts of the same kind", () => {
    const s = new PromptGroupStore({ retainRaw: false });
    const ls: string[] = [];
    [0.02, 0.17, 0.19, 0.5].forEach((u, i) => {
      const pid = `old-${i}`;
      ls.push(
        v2Envelope("claude-code", "UserPromptSubmit", `2026-10-1${i}T10:00:00Z`, {
          sessionId: `old${i}`, promptId: pid, raw: { prompt: "merge it" },
        }),
        costEnvelope("claude-code", `2026-10-1${i}T10:01:00Z`, `old${i}`, [
          req(`${pid}-r`, `2026-10-1${i}T10:00:30.000Z`, [0, 100, Math.round(u / 2e-7), 0]),
        ], { promptId: pid }),
      );
    });
    for (const l of [...ls, ...lines()]) {
      const env = parseEnvelopeV2(l);
      if (env) s.record(env, costEventsFrom(env));
    }
    const all = [...["old0", "old1", "old2", "old3", S].flatMap((k) => s.groupsFor(k))];
    const blog = all.find((g) => g.id === "p-blog")!;
    const h = compareHistory(blog, all)!;
    expect(h.kind).toBe("ship");
    expect(h.count).toBe(5); // 4 old merges + the "yes please" follow-up
    expect(h.cheapest!.promptId).toBe("old-0");
    expect(h.points.filter((p) => p.current)).toHaveLength(1);
  });
});
