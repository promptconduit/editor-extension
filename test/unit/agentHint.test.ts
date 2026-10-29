import { describe, expect, it } from "vitest";
import {
  agentTooltipLine,
  buildAgentHint,
  hostMcpTool,
  parseMcpStatus,
} from "../../src/agentHint";
import { buildCostPanelState } from "../../src/costPanel/viewModel";
import { renderBody, renderZones } from "../../webview/costPanel/render";
import { ConversationStore } from "../../src/state";

// Shape printed by `promptconduit mcp status --json` (cli cmd/status.go).
const CLI_OUTPUT = JSON.stringify({
  tools: [
    { tool: "claude-code", label: "Claude Code", registered: true, hooks_installed: true, turned_off: false },
    { tool: "cursor", label: "Cursor", registered: false, hooks_installed: true, turned_off: false },
    { tool: "gemini-cli", label: "Gemini CLI", registered: false, hooks_installed: false, turned_off: false },
  ],
  suggest: ["cursor"],
});

describe("parseMcpStatus", () => {
  it("reads the CLI's JSON", () => {
    const s = parseMcpStatus(CLI_OUTPUT);
    expect(s?.tools).toHaveLength(3);
    expect(s?.suggest).toEqual(["cursor"]);
  });

  it("rejects non-JSON and wrong shapes", () => {
    expect(parseMcpStatus("Error: unknown command \"status\"")).toBeUndefined();
    expect(parseMcpStatus("{}")).toBeUndefined();
    expect(parseMcpStatus("null")).toBeUndefined();
  });
});

describe("hostMcpTool", () => {
  it("registers Cursor's agent in Cursor, Claude Code elsewhere", () => {
    expect(hostMcpTool("Cursor")).toBe("cursor");
    expect(hostMcpTool("Visual Studio Code")).toBe("claude-code");
  });
});

describe("buildAgentHint", () => {
  const status = parseMcpStatus(CLI_OUTPUT);

  it("offers registration for this editor's agent and names the others", () => {
    const h = buildAgentHint(status, "cursor", false);
    expect(h?.registered).toBe(false);
    expect(h?.label).toBe("Cursor");
    expect(h?.otherRegistered).toEqual(["Claude Code"]);
    expect(h?.questions.some((q) => q.includes("team"))).toBe(false);
  });

  it("adds a team question when signed in", () => {
    const h = buildAgentHint(status, "claude-code", true);
    expect(h?.registered).toBe(true);
    expect(h?.questions.some((q) => q.includes("team"))).toBe(true);
  });

  it("hides when the CLI gave nothing or the user turned MCP off", () => {
    expect(buildAgentHint(undefined, "cursor", false)).toBeUndefined();
    const off = parseMcpStatus(
      JSON.stringify({
        tools: [{ tool: "cursor", label: "Cursor", registered: false, hooks_installed: true, turned_off: true }],
        suggest: [],
      }),
    );
    expect(buildAgentHint(off, "cursor", false)).toBeUndefined();
  });

  it("produces a tooltip line for both states", () => {
    expect(agentTooltipLine(buildAgentHint(status, "claude-code", false))).toContain("Ask your agent");
    expect(agentTooltipLine(buildAgentHint(status, "cursor", false))).toContain("register");
    expect(agentTooltipLine(undefined)).toBeUndefined();
  });
});

describe("agent hint render", () => {
  const status = parseMcpStatus(CLI_OUTPUT);

  it("shows a register button when not registered", () => {
    const state = buildCostPanelState(new ConversationStore(), "session");
    state.agentHint = buildAgentHint(status, "cursor", false);
    const html = renderBody(state);
    expect(html).toContain("Ask your agent");
    expect(html).toContain('data-cmd="registerMcp"');
    expect(html).toContain('data-cmd="dismissAgentHint"');
    expect(html).not.toContain('data-cmd="inviteTeammate"');
    // Lives below the fold, not next to the login offer.
    expect(renderZones(state).rest).toContain("agent-hint");
  });

  it("lists copyable questions and the invite action when registered and signed in", () => {
    const state = buildCostPanelState(new ConversationStore(), "all");
    state.agentHint = buildAgentHint(status, "claude-code", true);
    const html = renderBody(state);
    expect(html).not.toContain('data-cmd="registerMcp"');
    expect(html).toContain('class="copy-q"');
    expect(html).toContain('data-cmd="inviteTeammate"');
  });

  it("renders nothing without a hint", () => {
    const html = renderBody(buildCostPanelState(new ConversationStore(), "session"));
    expect(html).not.toContain("Ask your agent");
  });
});
