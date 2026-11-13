import { describe, expect, it } from "vitest";
import { ConversationStore } from "../../src/state";
import { parseEnvelopeV2, costEventsFrom } from "../../src/envelope";
import { buildLoopPanelState } from "../../src/loopPanel/viewModel";
import { renderApp } from "../../webview/loopPanel/render";
import { S, lines } from "../fixtures/blogPrompt";

function blogStore(): ConversationStore {
  const store = new ConversationStore();
  for (const line of lines()) {
    const env = parseEnvelopeV2(line);
    if (!env) continue;
    store.recordEnvelope(env);
    for (const ev of costEventsFrom(env)) store.recordEvent(ev);
  }
  store.setPinnedKey(S);
  return store;
}

const sel = { followLatest: false, promptId: "p-blog" };

describe("team comparison card", () => {
  it("links signed-in users to the team comparison, with an invite", () => {
    const state = buildLoopPanelState(blogStore(), sel, undefined, { signedIn: true });
    expect(state.signedIn).toBe(true);
    expect(state.teamUrl).toMatch(/^https:\/\/app\.promptconduit\.dev\/team\?utm_source=extension/);
    const html = renderApp(state);
    expect(html).toContain("Open team comparison");
    expect(html).toContain('data-cmd="inviteTeammate"');
    expect(html).not.toContain('class="primary" data-cmd="login"');
  });

  it("asks local-only users to sign in instead", () => {
    const html = renderApp(buildLoopPanelState(blogStore(), sel));
    expect(html).toContain("How your team does it");
    expect(html).toContain('data-cmd="login"');
    expect(html).not.toContain('data-cmd="inviteTeammate"');
  });
});
