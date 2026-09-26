import { describe, expect, it } from "vitest";
import { isCloudSyncEnabled } from "../../src/cloudAccount";
import { accumulateMonthSpend, LOGIN_CTA_MIN_SESSIONS } from "../../src/monthSpend";
import { shellQuote } from "../../src/syncOffer";
import { buildCostPanelState } from "../../src/costPanel/viewModel";
import { renderBody } from "../../webview/costPanel/render";
import { ConversationStore } from "../../src/state";

function line(opts: {
  id: string;
  session: string;
  ts: string;
  total: number;
  priced?: boolean;
}): string {
  return JSON.stringify({
    schema: 2,
    event_id: opts.id,
    session_id: opts.session,
    tool: "cursor",
    hook_event: "stop",
    captured_at: opts.ts,
    raw_event: {},
    enrichments: {
      cost: {
        requests: [
          {
            request_id: opts.id,
            ts: opts.ts,
            model: "composer-2.5",
            model_priced: opts.priced !== false,
            tokens: { input: 10, output: 2, cache_read: 0, cache_write: 0 },
            usd: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: opts.total, currency: "USD" },
          },
        ],
      },
    },
  });
}

const NOW = Date.parse("2026-09-25T12:00:00Z");

describe("isCloudSyncEnabled", () => {
  it("is false without a key", () => {
    expect(isCloudSyncEnabled(null)).toBe(false);
    expect(isCloudSyncEnabled({})).toBe(false);
  });

  it("uses the active environment and honors local-only", () => {
    expect(
      isCloudSyncEnabled({
        current_env: "prod",
        environments: { prod: { api_key: "sk_live" } },
      }),
    ).toBe(true);
    expect(
      isCloudSyncEnabled({
        current_env: "prod",
        local_only: true,
        environments: { prod: { api_key: "sk_live" } },
      }),
    ).toBe(false);
  });

  it("falls back to a flat api_key", () => {
    expect(isCloudSyncEnabled({ api_key: "sk_flat" })).toBe(true);
  });
});

describe("accumulateMonthSpend", () => {
  it("sums priced sessions inside the window and skips duplicates and old lines", () => {
    const recent = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();
    const old = new Date(NOW - 40 * 24 * 60 * 60 * 1000).toISOString();
    const spend = accumulateMonthSpend(
      [
        line({ id: "a", session: "s1", ts: recent, total: 1.25 }),
        line({ id: "a", session: "s1", ts: recent, total: 1.25 }),
        line({ id: "b", session: "s2", ts: recent, total: 0.5 }),
        line({ id: "c", session: "s3", ts: recent, total: 0.25 }),
        line({ id: "d", session: "s4", ts: old, total: 9 }),
        line({ id: "e", session: "s5", ts: recent, total: 4, priced: false }),
        "not json",
      ],
      NOW,
    );
    expect(spend.usd).toBeCloseTo(2);
    expect(spend.sessions).toBe(3);
    expect(spend.sessions).toBeGreaterThanOrEqual(LOGIN_CTA_MIN_SESSIONS);
  });
});

describe("shellQuote", () => {
  it("leaves a simple path bare and quotes spaces", () => {
    expect(shellQuote("/opt/homebrew/bin/promptconduit")).toBe("/opt/homebrew/bin/promptconduit");
    expect(shellQuote("promptconduit")).toBe("promptconduit");
    expect(shellQuote("/Users/a b/promptconduit")).toBe("'/Users/a b/promptconduit'");
  });
});

describe("sync offer render", () => {
  it("renders the login prompt when a sync offer is present", () => {
    const state = buildCostPanelState(new ConversationStore(), "session", "session", {
      usd: 12.5,
      sessions: 4,
      windowDays: 30,
    });
    const html = renderBody(state);
    expect(html).toContain("promptconduit login");
    expect(html).toContain("$12.50");
    expect(html).toContain("4 sessions");
    expect(html).toContain('data-cmd="dismissLogin"');
  });

  it("omits the prompt when there is no offer", () => {
    const html = renderBody(buildCostPanelState(new ConversationStore(), "session"));
    expect(html).not.toContain("Keep this month");
  });
});
