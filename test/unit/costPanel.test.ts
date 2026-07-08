import { describe, it, expect } from "vitest";
import { ConversationStore } from "../../src/state";
import { parseEnvelopeV2, costEventsFrom } from "../../src/envelope";
import { buildCostPanelState } from "../../src/costPanel/viewModel";
import {
  renderBody,
  renderZones,
  termHtml,
  modeBadgeHtml,
  vcsLineHtml,
  comparisonHtml,
  groupModelTotal,
} from "../../webview/costPanel/render";
import { highlightJson, escapeHtml } from "../../webview/costPanel/jsonHighlight";
import { samplePromptStoryLines } from "../../dev/fixtures";
import type { PromptGroup } from "../../src/promptGroup";
import type { ModelTotal } from "../../src/types";

function storyStore(): ConversationStore {
  const store = new ConversationStore();
  for (const line of samplePromptStoryLines) {
    const env = parseEnvelopeV2(line);
    if (!env) {
      continue;
    }
    store.recordEnvelope(env);
    for (const ev of costEventsFrom(env)) {
      store.recordEvent(ev);
    }
  }
  return store;
}

describe("buildCostPanelState", () => {
  it("carries per-prompt groups, vcs, and coaching content for the session", () => {
    const state = buildCostPanelState(storyStore(), "session");
    expect(state.mode).toBe("session");
    expect(state.sessions).toHaveLength(1);
    const s = state.sessions[0];
    expect(s.prompts.map((g) => g.id)).toEqual(["p1", "p2"]);
    expect(s.prompts[0].permissionMode).toBe("plan");
    expect(s.prompts[0].subagents).toHaveLength(1);
    expect(s.prompts[0].toolCalls.map((t) => t.name)).toContain("mcp__github__search_issues");
    expect(s.prompts[1].toolCalls[0].ok).toBe(false);
    expect(s.vcs?.pr?.number).toBe(65);
    expect(s.vcs?.is_worktree).toBe(true);
    expect(state.links.length).toBeGreaterThan(0);
  });

  it("all mode lists every conversation and flags the active one", () => {
    const state = buildCostPanelState(storyStore(), "all");
    expect(state.mode).toBe("all");
    expect(state.sessions.some((s) => s.isActive)).toBe(true);
  });
});

describe("renderBody (session mode)", () => {
  const state = buildCostPanelState(storyStore(), "session");
  const html = renderBody(state);

  it("renders the ledger with prompt excerpts, mode badges, and cost", () => {
    expect(html).toContain("Cost per prompt");
    expect(html).toContain("Review the cost breakdown code");
    expect(html).toContain("plan mode");
    expect(html).toContain("accept edits");
  });

  it("renders tool calls with MCP chip and failure marker", () => {
    expect(html).toContain("mcp__github__search_issues");
    expect(html).toContain("1 failed");
  });

  it("renders the subagent lane with per-agent cost", () => {
    expect(html).toContain("Subagents (1)");
    expect(html).toContain("claude-sonnet-4-6");
  });

  it("renders model comparison both directions with the caveat", () => {
    expect(html).toContain("What if");
    expect(html).toContain("would have saved");
    expect(html).toContain("rate comparison, not a capability comparison");
  });

  it("renders the VCS context line with linked PR and worktree badge", () => {
    expect(html).toContain("PR #65");
    expect(html).toContain("worktree");
    expect(html).toContain("feat/cost-breakdown-detail-report");
  });

  it("renders raw events with highlighted JSON and copy buttons", () => {
    expect(html).toContain("Raw events");
    expect(html).toContain('class="tape"');
    expect(html).toContain("Copy JSON");
  });

  it("uses data attributes for geometry (CSP forbids style attrs)", () => {
    expect(html).toContain("data-w=");
    expect(html).not.toMatch(/style="/);
  });
});

describe("renderZones diffing contract", () => {
  it("ledger items carry stable ids and revs", () => {
    const zones = renderZones(buildCostPanelState(storyStore(), "session"));
    expect(zones.ledger).toBeDefined();
    const items = zones.ledger!.items;
    expect(items.map((i) => i.id)).toEqual(["p2", "p1"]); // newest first
    for (const i of items) {
      expect(i.rev).toBeGreaterThan(0);
      expect(i.html).toContain(`data-exp="${i.id}"`);
    }
  });

  it("toolbar exposes a refresh control", () => {
    const zones = renderZones(buildCostPanelState(storyStore(), "session"));
    expect(zones.top).toContain('data-cmd="refresh"');
  });
});

describe("escaping (model/user-controlled strings)", () => {
  const INJ = `<img src=x onerror=alert(1)>"'&`;

  it("escapes prompt text end-to-end", () => {
    const store = new ConversationStore();
    const line = samplePromptStoryLines[0].replace(
      "Review the cost breakdown code and handle any edge cases we may have missed.",
      INJ.replace(/"/g, '\\"'),
    );
    const env = parseEnvelopeV2(line);
    expect(env).toBeTruthy();
    store.recordEnvelope(env!);
    const html = renderBody(buildCostPanelState(store, "session"));
    expect(html).not.toContain("<img src=x");
  });

  it("highlightJson escapes before wrapping tokens", () => {
    const pretty = JSON.stringify({ evil: INJ, n: 3, ok: true }, null, 2);
    const out = highlightJson(pretty);
    expect(out).not.toContain("<img");
    expect(out).toContain("j-key");
    expect(out).toContain("j-num");
    expect(out).toContain("j-kw");
  });

  it("escapeHtml covers the full quintet", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("termHtml escapes labels and unknown keys fall back to plain text", () => {
    expect(termHtml("input_tokens", INJ)).not.toContain("<img");
    expect(termHtml("nope_key", "label")).toBe("label");
    expect(termHtml("cache_write", "cache write")).toContain("role=\"tooltip\"");
  });

  it("modeBadgeHtml ignores unknown modes", () => {
    expect(modeBadgeHtml("evil<script>")).toBe("");
    expect(modeBadgeHtml("plan")).toContain("plan mode");
  });

  it("vcsLineHtml escapes repo/branch/PR title", () => {
    const html = vcsLineHtml({
      key: "k",
      tool: "claude-code",
      summary: { session_id: "k", tool: "claude-code", source: "exact", started_at: "", updated_at: "", totals: { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_total: 0, currency: "USD" }, by_model: [], signals: undefined },
      prompts: [],
      droppedRequests: 0,
      droppedPrompts: 0,
      isActive: false,
      lastActivity: 0,
      vcs: {
        repo: INJ,
        branch: "main",
        pr_url: "https://github.com/x/y/pull/1",
        pr: { number: 1, title: INJ, state: "open" },
      },
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("PR #1");
  });
});

describe("comparison rendering", () => {
  it("says unpriced when the model has no rate", () => {
    const mt: ModelTotal = {
      model: "mystery-model-9",
      model_priced: false,
      tokens: { input: 100, output: 100, cache_read: 0, cache_write: 0 },
      cost_total: 1,
    };
    const html = comparisonHtml(mt, "claude-code", "this session");
    expect(html).toContain("Can't compare");
  });

  it("groupModelTotal aggregates a group's requests by dominant model", () => {
    const g: PromptGroup = {
      id: "g",
      kind: "prompt",
      requests: [
        {
          tool: "claude-code", session_id: "s", request_id: "a", ts: "", cwd_base: "",
          model: "claude-opus-4-8", model_priced: true, source: "exact",
          tokens: { input: 10, output: 10, cache_read: 0, cache_write: 0 },
          cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0.9, currency: "USD" },
        },
        {
          tool: "claude-code", session_id: "s", request_id: "b", ts: "", cwd_base: "",
          model: "claude-haiku-4-5", model_priced: true, source: "exact",
          tokens: { input: 10, output: 10, cache_read: 0, cache_write: 0 },
          cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0.1, currency: "USD" },
        },
      ],
      toolCalls: [], subagents: [], permissions: [], rawEvents: [], rev: 1,
    };
    expect(groupModelTotal(g)?.model).toBe("claude-opus-4-8");
  });
});
