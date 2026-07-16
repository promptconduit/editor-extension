import { describe, it, expect } from "vitest";
import { parseEnvelopeV2 } from "../../src/envelope";
import { SessionTreeStore } from "../../src/graphPanel/sessionTree";
import { renderGraphBody } from "../../webview/graphPanel/render";
import type { GraphPanelState } from "../../src/graphPanel/protocol";
import { sampleGraphLines, GRAPH_FIXTURE_NOW, v2Envelope } from "../../dev/fixtures";

function stateFrom(lines: string[]): GraphPanelState {
  const store = new SessionTreeStore();
  for (const line of lines) {
    const env = parseEnvelopeV2(line);
    if (env) store.ingest(env);
  }
  return { revision: 1, logDisabled: false, ...store.snapshot(undefined, GRAPH_FIXTURE_NOW) };
}

describe("renderGraphBody", () => {
  const html = renderGraphBody(stateFrom(sampleGraphLines), GRAPH_FIXTURE_NOW);

  it("renders the session root with repo, live badge, and total cost", () => {
    expect(html).toContain(`data-node="session"`);
    expect(html).toContain("promptconduit/platform @ feat/live-graph");
    expect(html).toContain(`class="live-label on"`);
    expect(html).toContain("$0.67");
  });

  it("renders every node state as a data-state attribute", () => {
    expect(html).toContain(`data-state="completed"`);
    expect(html).toContain(`data-state="interrupted"`);
    expect(html).toContain(`data-state="running"`);
  });

  it("renders aggregated tool chips with failed highlighting", () => {
    expect(html).toContain(">Read ×4<");
    expect(html).toContain(`class="chip failed"`);
    expect(html).toContain(">Bash ×2<");
  });

  it("nests subagents under their turn with duration, cost, and model", () => {
    expect(html).toContain(`data-parent="t:g1"`);
    expect(html).toContain(`data-node="a:g1:g-a1"`);
    expect(html).toContain("Explore");
    expect(html).toContain("1m 25s");
    expect(html).toContain("$0.14");
    expect(html).toContain("claude-sonnet-5");
  });

  it("badges the subagent that ran in a different worktree", () => {
    // The g-a2 agent ran in /worktrees/x while the session did not.
    const agent = html.slice(html.indexOf(`data-node="a:g3:g-a2"`));
    expect(agent).toContain(`class="pill worktree"`);
    expect(agent).toContain("⑂ x");
  });

  it("lists sessions in the picker with the selected one marked", () => {
    expect(html).toContain("select");
    expect(html).toMatch(/<option value="cc-graph" selected>/);
  });

  it("escapes model/user-controlled text", () => {
    const hostile = stateFrom([
      v2Envelope("claude-code", "UserPromptSubmit", "2026-07-06T18:00:00Z", {
        sessionId: "cc-xss",
        promptId: "px",
        raw: { prompt: `<img src=x onerror=alert(1)> & "quotes"` },
      }),
    ]);
    const out = renderGraphBody(hostile, GRAPH_FIXTURE_NOW);
    expect(out).not.toContain("<img src=x");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;");
  });

  it("renders the disabled and empty zero-states", () => {
    const empty = renderGraphBody(
      { revision: 1, logDisabled: false, sessions: [] },
      GRAPH_FIXTURE_NOW,
    );
    expect(empty).toContain("No sessions yet");

    const disabled = renderGraphBody(
      { revision: 1, logDisabled: true, sessions: [] },
      GRAPH_FIXTURE_NOW,
    );
    expect(disabled).toContain("PROMPTCONDUIT_EVENT_LOG=0");
  });
});
