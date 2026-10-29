// "Ask your agent": the CLI ships an MCP server (`promptconduit mcp`), so the
// agent in this editor can answer cost and budget questions itself. This reads
// `promptconduit mcp status --json` to see whether the server is registered
// with this editor's agent, and offers a one-click register when it isn't.
//
// An old CLI (no `mcp status`) or no CLI at all hides the hint: we never offer
// a button that can't work.

import { execFile } from "child_process";
import * as vscode from "vscode";
import { readCloudSyncEnabled } from "./cloudAccount";
import { shellQuote } from "./syncOffer";
import type { AgentHint } from "./costPanel/protocol";

const DISMISS_KEY = "promptconduit.agentHint.dismissed";
const REFRESH_MS = 5 * 60_000;

/** One tool's row from `mcp status --json` (cli cmd/status.go mcpToolStatus). */
export interface McpToolStatus {
  tool: string;
  label: string;
  registered: boolean;
  hooks_installed: boolean;
  turned_off: boolean;
}

export interface McpStatus {
  tools: McpToolStatus[];
  suggest: string[];
}

/** Parse `mcp status --json`. Anything unexpected is undefined (hint hidden). */
export function parseMcpStatus(raw: string): McpStatus | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object" || !Array.isArray((data as McpStatus).tools)) {
    return undefined;
  }
  const d = data as { tools: unknown[]; suggest?: unknown };
  const tools = d.tools.filter(
    (t): t is McpToolStatus =>
      !!t &&
      typeof t === "object" &&
      typeof (t as McpToolStatus).tool === "string" &&
      typeof (t as McpToolStatus).registered === "boolean",
  );
  const suggest = Array.isArray(d.suggest)
    ? d.suggest.filter((s): s is string => typeof s === "string")
    : [];
  return { tools, suggest };
}

/** The MCP tool to register for this editor: Cursor's own agent, else Claude Code. */
export function hostMcpTool(appName: string): string {
  return appName.toLowerCase().includes("cursor") ? "cursor" : "claude-code";
}

const LABELS: Record<string, string> = {
  cursor: "Cursor",
  "claude-code": "Claude Code",
  "gemini-cli": "Gemini CLI",
};

/** Example questions the MCP tools can answer. Team ones need a login. */
export function agentQuestions(signedIn: boolean): string[] {
  const local = ["What has this session cost so far?", "What did I spend on AI each day this week?"];
  return signedIn
    ? [...local, "How is my team tracking against this month's AI budget?"]
    : [...local, "Which of my recent sessions cost the most?"];
}

export function buildAgentHint(
  status: McpStatus | undefined,
  hostTool: string,
  signedIn: boolean,
): AgentHint | undefined {
  if (!status) {
    return undefined;
  }
  const host = status.tools.find((t) => t.tool === hostTool);
  if (!host) {
    return undefined;
  }
  // The user ran `mcp uninstall` for this tool: respect it, don't nag.
  if (host.turned_off && !host.registered) {
    return undefined;
  }
  return {
    tool: host.tool,
    label: host.label || LABELS[host.tool] || host.tool,
    registered: host.registered,
    otherRegistered: status.tools
      .filter((t) => t.registered && t.tool !== host.tool)
      .map((t) => t.label || LABELS[t.tool] || t.tool),
    signedIn,
    questions: agentQuestions(signedIn),
  };
}

/** The status-bar tooltip line for a hint, or undefined for none. */
export function agentTooltipLine(hint: AgentHint | undefined): string | undefined {
  if (!hint) {
    return undefined;
  }
  return hint.registered
    ? `Ask your agent: _"${hint.questions[0]}"_ (PromptConduit MCP is registered with ${hint.label}).`
    : `Your agent can answer cost questions: open the breakdown to register PromptConduit's MCP server with ${hint.label}.`;
}

function runCli(bin: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export class AgentHintController {
  private hint: AgentHint | undefined;
  private onChange: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly hostTool: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly resolveCli: () => string | null,
  ) {
    this.hostTool = hostMcpTool(vscode.env.appName);
  }

  current(): AgentHint | undefined {
    return this.hint;
  }

  setOnChange(fn: () => void): void {
    this.onChange = fn;
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, REFRESH_MS);
  }

  dismiss(): void {
    void this.context.globalState.update(DISMISS_KEY, true);
    this.set(undefined);
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async refresh(): Promise<void> {
    this.set(await this.compute());
  }

  /** Register the MCP server with this editor's agent (`mcp install <tool>`). */
  async register(): Promise<void> {
    const bin = this.resolveCli();
    const label = LABELS[this.hostTool] ?? this.hostTool;
    if (!bin) {
      void vscode.window.showErrorMessage(
        "PromptConduit CLI was not found. Install it, then run promptconduit mcp install.",
      );
      return;
    }
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Registering PromptConduit with ${label}…` },
        () => runCli(bin, ["mcp", "install", this.hostTool], 60_000),
      );
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const detail = (e.stderr || e.message || "").trim().split("\n")[0];
      const pick = await vscode.window.showErrorMessage(
        `Couldn't register PromptConduit with ${label}${detail ? `: ${detail}` : "."}`,
        "Run in terminal",
      );
      if (pick) {
        const term = vscode.window.createTerminal({ name: "PromptConduit MCP" });
        term.show();
        term.sendText(`${shellQuote(bin)} mcp install ${this.hostTool}`);
      }
      return;
    }
    await this.refresh();
    const where =
      this.hostTool === "cursor"
        ? " Start a new agent chat (enable it under Cursor Settings → MCP if it shows as off)."
        : " Start a new Claude Code session to pick it up.";
    void vscode.window.showInformationMessage(
      `PromptConduit is registered with ${label}.${where} Then ask: "What has this session cost so far?"`,
    );
  }

  private set(next: AgentHint | undefined): void {
    const same = JSON.stringify(next) === JSON.stringify(this.hint);
    this.hint = next;
    if (!same) {
      this.onChange?.();
    }
  }

  private async compute(): Promise<AgentHint | undefined> {
    if (this.context.globalState.get<boolean>(DISMISS_KEY, false)) {
      return undefined;
    }
    const bin = this.resolveCli();
    if (!bin) {
      return undefined;
    }
    let status: McpStatus | undefined;
    try {
      const { stdout } = await runCli(bin, ["mcp", "status", "--json"], 8000);
      status = parseMcpStatus(stdout);
    } catch {
      return undefined; // no CLI, or one older than `mcp status`
    }
    return buildAgentHint(status, this.hostTool, readCloudSyncEnabled());
  }
}
