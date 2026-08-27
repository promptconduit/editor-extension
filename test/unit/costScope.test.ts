import { describe, it, expect } from "vitest";
import { aggregateScope, scopeChips, stripBranchPrefix } from "../../src/costScope";
import { ConversationStore } from "../../src/state";
import { parseEnvelopeV2, costEventsFrom } from "../../src/envelope";
import { costEnvelope, costRequest, v2Envelope } from "../../dev/fixtures";

function ingestSession(
  store: ConversationStore,
  session: string,
  branch: string,
  total: number,
): void {
  const prompt = parseEnvelopeV2(
    v2Envelope("claude-code", "UserPromptSubmit", "2026-07-06T17:00:00Z", {
      sessionId: session,
      promptId: `p-${session}`,
      raw: { prompt: "work" },
      enrichments: { vcs: { repo: "acme/app", branch } },
    }),
  );
  if (prompt) store.recordEnvelope(prompt);
  const stop = parseEnvelopeV2(
    costEnvelope(
      "claude-code",
      "2026-07-06T17:00:30Z",
      session,
      [
        costRequest({
          request_id: `${session}-r`,
          usd: { input: 0, output: 0, cache_read: 0, cache_write: 0, total, currency: "USD" },
        }),
      ],
      { promptId: `p-${session}`, enrichments: { vcs: { repo: "acme/app", branch } } },
    ),
  );
  if (stop) {
    store.recordEnvelope(stop);
    for (const ev of costEventsFrom(stop)) {
      store.recordEvent(ev);
    }
  }
}

describe("stripBranchPrefix", () => {
  it("strips conventional branch prefixes for display", () => {
    expect(stripBranchPrefix("feat/cost-ux")).toBe("cost-ux");
    expect(stripBranchPrefix("fix/bug")).toBe("bug");
    expect(stripBranchPrefix("main")).toBe("main");
  });
});

describe("aggregateScope", () => {
  it("sums cost across sessions on the same branch", () => {
    const store = new ConversationStore();
    ingestSession(store, "s3", "main", 0.9);
    ingestSession(store, "s1", "feat/alpha", 0.5);
    ingestSession(store, "s2", "feat/alpha", 0.3);

    const branchTotals = aggregateScope(store, "branch");
    expect(branchTotals.usd).toBeCloseTo(0.8);
    expect(branchTotals.kicker).toContain("alpha");
  });
});

describe("scopeChips", () => {
  it("disables PR chip when no open PR on events", () => {
    const store = new ConversationStore();
    const env = parseEnvelopeV2(
      v2Envelope("claude-code", "UserPromptSubmit", "2026-07-06T17:00:00Z", {
        sessionId: "solo",
        enrichments: { vcs: { repo: "acme/app", branch: "feat/x" } },
      }),
    );
    if (env) store.recordEnvelope(env);
    const chips = scopeChips(store, "session");
    expect(chips.find((c) => c.id === "pr")?.disabled).toBe(true);
    expect(chips.find((c) => c.id === "branch")?.disabled).toBe(false);
  });
});
