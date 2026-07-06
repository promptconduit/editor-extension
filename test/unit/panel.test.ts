import { describe, it, expect } from "vitest";
import { renderBreakdownHtml, renderSessionBreakdownHtml, BreakdownView } from "../../src/panel";
import { ConversationView } from "../../src/state";
import { cleanSummary, heavySummary, sampleEvents } from "../../dev/fixtures";
import type { CostEvent, SessionSummary } from "../../src/types";

function conv(p: {
  key: string;
  summary: SessionSummary;
  tool?: string;
  lastEvent?: CostEvent;
  recent?: CostEvent[];
  droppedRequests?: number;
  lastActivity?: number;
  diff?: { files_changed?: number; insertions?: number; deletions?: number };
  subagents?: { count: number; totalDurationMs: number; totalUsd: number; dominantType: string };
}): ConversationView {
  return {
    key: p.key,
    tool: p.tool ?? p.summary.tool,
    summary: p.summary,
    lastEvent: p.lastEvent,
    recent: p.recent ?? [],
    droppedRequests: p.droppedRequests ?? 0,
    lastActivity: p.lastActivity ?? Date.parse(p.summary.updated_at) ?? 0,
    diff: p.diff,
    subagents: p.subagents,
  };
}

function view(conversations: ConversationView[], activeKey?: string): BreakdownView {
  return { conversations, activeKey: activeKey ?? conversations[0]?.key };
}

describe("renderSessionBreakdownHtml — single session", () => {
  it("shows one session without the multi-session list", () => {
    const c = conv({
      key: "s-heavy",
      summary: heavySummary,
      lastEvent: sampleEvents[2],
      recent: sampleEvents,
    });
    const html = renderSessionBreakdownHtml(c);
    expect(html).toContain("This session would cost");
    expect(html).toContain("Cost per prompt");
    expect(html).toContain("By model");
    expect(html).not.toContain("By session");
    expect(html).not.toContain("These 2 sessions");
  });

  it("shows landing when no conversation", () => {
    const html = renderSessionBreakdownHtml(undefined);
    expect(html).toContain("AI Session Cost");
  });

  it("counts store-evicted requests in the older-prompts note", () => {
    const c = conv({
      key: "s-heavy",
      summary: heavySummary,
      lastEvent: sampleEvents[2],
      recent: sampleEvents,
      droppedRequests: 7,
    });
    const html = renderSessionBreakdownHtml(c);
    expect(html).toContain("+7 older prompts not shown");
  });
});

describe("renderBreakdownHtml — zero state", () => {
  const html = renderBreakdownHtml(view([]));

  it("shows the landing document when nothing has happened yet", () => {
    expect(html).toContain("AI Session Cost");
    expect(html).toContain("100% local");
  });

  it("still teaches: landing carries both Claude and Cursor doc links", () => {
    expect(html).toMatch(/claude\.com/);
    expect(html).toContain("cursor.com");
  });
});

describe("renderBreakdownHtml — priced session", () => {
  const html = renderBreakdownHtml(
    view([conv({ key: "s-heavy", summary: heavySummary, lastEvent: sampleEvents[2], recent: sampleEvents })]),
  );

  it("leads with the counterfactual API-cost framing", () => {
    expect(html).toContain("This session would cost");
    expect(html).toContain("Claude API pay-as-you-go rates"); // tool: claude-code
    expect(html).toContain("subscription");
    expect(html).toContain("$0.92"); // heavySummary cost_total, hero precision
  });

  it("renders every section of the breakdown", () => {
    expect(html).toContain("By session");
    expect(html).toContain("Cost per prompt");
    expect(html).toContain("What's driving your cost");
    expect(html).toContain("Make it cheaper");
    expect(html).toContain("Reading these numbers"); // edge cases (unpriced model present)
    expect(html).toContain("By model");
    expect(html).toContain("Learn more — spend fewer tokens");
  });

  it("draws a relative-cost bar for each prompt", () => {
    expect(html).toContain("bar-fill");
  });

  it("links cost-reduction docs for Claude and Cursor", () => {
    expect(html).toMatch(/href="https:\/\/[^"]*claude\.com/);
    expect(html).toMatch(/href="https:\/\/cursor\.com/);
  });

  it("keeps the 100%-local promise in the footer", () => {
    expect(html).toContain("None of your data is sent anywhere");
  });
});

describe("renderBreakdownHtml — multiple sessions", () => {
  const html = renderBreakdownHtml(
    view(
      [
        conv({ key: "s2", summary: cleanSummary, lastEvent: sampleEvents[2], recent: [sampleEvents[2]] }),
        conv({ key: "s-heavy", summary: heavySummary, recent: sampleEvents.slice(0, 2) }),
      ],
      "s2",
    ),
  );

  it("sums the hero across every session", () => {
    // 0.92 + 0.21 = 1.13
    expect(html).toContain("$1.13");
    expect(html).toContain("These 2 sessions would cost");
  });

  it("shows one card per session with both tool badges", () => {
    expect(html).toContain("Cursor");
    expect(html).toContain("Claude Code");
    expect((html.match(/details class="session"/g) ?? []).length).toBe(2);
  });

  it("marks the active session and opens its card", () => {
    expect(html).toContain("active-pill");
    expect(html).toContain(`details class="session" open`);
  });

  it("shows diff and subagent enrichment lines on session cards", () => {
    const html = renderBreakdownHtml(
      view([
        conv({
          key: "cc-enrich",
          summary: cleanSummary,
          diff: { files_changed: 3, insertions: 120, deletions: 40 },
          subagents: { count: 2, totalDurationMs: 190000, totalUsd: 0.31, dominantType: "Explore" },
        }),
      ]),
    );
    expect(html).toContain("+120/−40 across 3 files");
    expect(html).toContain("2 subagents");
    expect(html).toContain("Explore");
    expect(html).toContain("190s");
    expect(html).toContain("$0.31");
  });
});

describe("renderBreakdownHtml — tool awareness", () => {
  it("frames a Cursor session against generic API rates and the Cursor sub", () => {
    const cursor: SessionSummary = { ...cleanSummary, tool: "cursor" };
    const html = renderBreakdownHtml(view([conv({ key: "c", summary: cursor })]));
    expect(html).toContain("API pay-as-you-go rates");
    expect(html).not.toContain("Claude API pay-as-you-go rates");
  });
});

describe("renderBreakdownHtml — unpriced session", () => {
  it("shows 'Unpriced' rather than a misleading $0.00", () => {
    const unpriced: SessionSummary = {
      ...cleanSummary,
      source: "estimate",
      totals: { input: 5000, output: 1000, cache_read: 0, cache_write: 0, cost_total: 0, currency: "USD" },
      by_model: [
        { model: "composer-x", model_priced: false, tokens: { input: 5000, output: 1000, cache_read: 0, cache_write: 0 }, cost_total: 0 },
      ],
      signals: undefined,
    };
    const html = renderBreakdownHtml(view([conv({ key: "u", summary: unpriced })]));
    expect(html).toContain("Unpriced");
    expect(html).toContain("Tokens tracked");
    expect(html).toContain("Reading these numbers");
  });
});

describe("renderBreakdownHtml — escaping", () => {
  it("escapes HTML in model names from the feed", () => {
    const evil: CostEvent = {
      ...sampleEvents[0],
      model: "<script>alert(1)</script>",
      request_id: "evil-1",
    };
    const html = renderBreakdownHtml(
      view([conv({ key: "e", summary: heavySummary, lastEvent: evil, recent: [evil] })]),
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
