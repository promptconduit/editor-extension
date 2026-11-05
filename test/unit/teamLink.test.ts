import { describe, expect, it } from "vitest";
import { ConversationStore } from "../../src/state";
import { parseEnvelopeV2, costEventsFrom } from "../../src/envelope";
import { buildCostPanelState, TEAM_SPEND_URL } from "../../src/costPanel/viewModel";
import { renderBody, teamLinkHtml } from "../../webview/costPanel/render";
import { samplePromptStoryLines } from "../../dev/fixtures";

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

describe("team spend link", () => {
  it("points at the team dashboard with extension UTM tags", () => {
    const url = new URL(TEAM_SPEND_URL);
    expect(url.origin + url.pathname).toBe("https://app.promptconduit.dev/team");
    expect(url.searchParams.get("utm_source")).toBe("extension");
    expect(url.searchParams.get("utm_medium")).toBe("cost_panel");
    expect(url.searchParams.get("utm_campaign")).toBe("team_spend");
  });

  it("is only offered to signed-in users", () => {
    expect(buildCostPanelState(storyStore(), "session").teamUrl).toBeUndefined();
    expect(buildCostPanelState(storyStore(), "session", "session", undefined, true).teamUrl).toBe(TEAM_SPEND_URL);
  });

  it("renders in session and all-sessions views when signed in", () => {
    for (const mode of ["session", "all"] as const) {
      const html = renderBody(buildCostPanelState(storyStore(), mode, "session", undefined, true));
      expect(html).toContain('class="team-link');
      expect(html).toContain("https://app.promptconduit.dev/team?");
    }
  });

  it("renders nothing for local-only users", () => {
    const state = buildCostPanelState(storyStore(), "session");
    expect(teamLinkHtml(state)).toBe("");
    expect(renderBody(state)).not.toContain("team-link");
  });
});
