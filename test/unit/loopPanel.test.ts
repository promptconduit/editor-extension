import { describe, it, expect } from "vitest";
import { costEventsFrom, parseEnvelopeV2 } from "../../src/envelope";
import { ConversationStore } from "../../src/state";
import { buildLoopPanelState } from "../../src/loopPanel/viewModel";
import { renderApp, loopSvg } from "../../webview/loopPanel/render";
import { S, lines } from "../fixtures/blogPrompt";

// Feed the real blog-post fixture through the same path as the extension:
// every envelope to recordEnvelope, every cost event to recordEvent.
function storeWithBlog(): ConversationStore {
  const store = new ConversationStore();
  for (const l of lines()) {
    const env = parseEnvelopeV2(l);
    if (!env) continue;
    store.recordEnvelope(env);
    for (const ev of costEventsFrom(env)) store.recordEvent(ev);
  }
  store.setPinnedKey(S);
  return store;
}

describe("buildLoopPanelState", () => {
  it("shows the newest priced prompt while following latest", () => {
    const s = buildLoopPanelState(storeWithBlog(), { followLatest: true });
    expect(s.session?.key).toBe(S);
    expect(s.selectedPromptId).toBe("p-next");
    expect(s.session?.prompts.map((p) => p.id)).toEqual(["p-next", "p-blog", "p-ci"]);
  });

  it("keeps a picked prompt and builds its ledger and advice", () => {
    const s = buildLoopPanelState(storeWithBlog(), { followLatest: false, promptId: "p-blog" });
    expect(s.selectedPromptId).toBe("p-blog");
    expect(s.ledger?.roundTrips).toBe(8);
    const ids = s.advice.map((a) => a.id);
    expect(ids).toContain("fewer-round-trips");
    expect(ids).toContain("after-prompt-wake");
    // Guide links are UTM-tagged coaching articles.
    expect(s.advice.find((a) => a.id === "fewer-round-trips")?.guideUrl).toMatch(
      /^https:\/\/promptconduit\.dev\/coaching\/batch-tool-calls\?utm_source=extension/,
    );
    expect(s.session?.opening?.firstCallContext).toBeGreaterThan(0);
  });
});

describe("renderApp", () => {
  it("renders the empty state with no session", () => {
    const html = renderApp(buildLoopPanelState(new ConversationStore(), { followLatest: true }));
    expect(html).toContain("Run a prompt in Claude Code or Cursor");
  });

  it("explains where the money went for the blog prompt", () => {
    const html = renderApp(buildLoopPanelState(storeWithBlog(), { followLatest: false, promptId: "p-blog" }));
    expect(html).toContain("$0.70 for this prompt.");
    expect(html).toContain("re-reading the conversation");
    expect(html).toContain("What would have made this cheaper");
    expect(html).toContain("Charged after the prompt finished");
    expect(html).toContain("after the prompt ended");
    // Prompt text is escaped into the picker.
    expect(html).toContain("publish the blog post");
    // No inline style attributes: the webview CSP blocks them.
    expect(html).not.toMatch(/\sstyle="/);
  });

  it("escapes prompt text", () => {
    const store = storeWithBlog();
    const s = buildLoopPanelState(store, { followLatest: false, promptId: "p-blog" });
    s.promptText = `<img src=x onerror=alert(1)>`;
    expect(renderApp(s)).not.toContain("<img src=x");
  });

  it("draws one column per call, wake-up last", () => {
    const s = buildLoopPanelState(storeWithBlog(), { followLatest: false, promptId: "p-blog" });
    const { svg } = loopSvg(s.ledger!);
    expect(svg.match(/class="col"/g)).toHaveLength(9);
    expect(svg).toContain("Bash");
  });
});
