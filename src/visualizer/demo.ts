// A baked, always-gorgeous demo session. Shown (auto-playing) when the local log
// is empty/disabled so the panel is never blank on first run. Built through the
// real GraphBuilder from synthetic envelopes — so it exercises the same path as
// real data — then GitHub refs are overlaid with titles/state (which inference
// alone can't provide) for a complete-looking hover card.
import type { Scene, GitHubRefs } from "./types";
import { GraphBuilder } from "./graph";
import type { RawEnvelope } from "./envelope";

// Fixed base time keeps the demo deterministic (and unit-testable).
const BASE = 1_700_000_000_000;
const at = (offsetMs: number): string => new Date(BASE + offsetMs).toISOString();

const GIT = {
  repo_name: "editor-extension",
  branch: "feat/15-orchestration-theater",
  commit_hash: "a1b2c3d4e5f6",
  commit_message: "feat: 3D orchestration theater (Closes #42)",
  remote_url: "git@github.com:promptconduit/editor-extension.git",
};

const DEMO_REFS: GitHubRefs = {
  owner: "promptconduit",
  repo: "editor-extension",
  repoUrl: "https://github.com/promptconduit/editor-extension",
  refs: [
    {
      kind: "issue",
      number: 15,
      url: "https://github.com/promptconduit/editor-extension/issues/15",
      title: "Local agent-orchestration visibility (epic)",
      state: "open",
    },
    {
      kind: "pr",
      number: 42,
      url: "https://github.com/promptconduit/editor-extension/pull/42",
      title: "feat: 3D Orchestration Theater",
      state: "merged",
    },
  ],
};

function mk(offset: number, hookEvent: string, native: Record<string, unknown>): RawEnvelope {
  return {
    tool: "claude-code",
    hookEvent,
    capturedAt: at(offset),
    native: native as RawEnvelope["native"],
    git: GIT,
    correlation: { trace_id: "demo-trace", span_id: `span-${offset}` },
  };
}

function post(offset: number, name: string, input: unknown, response: unknown, id: string): RawEnvelope {
  return mk(offset, "PostToolUse", {
    tool_name: name,
    tool_input: input,
    tool_response: response,
    tool_use_id: id,
  });
}

// A believable orchestration: a lead agent spawns three sub-agents that fetch
// from the web, read/write files, run a command, and call cloud (MCP) tools.
const ENVELOPES: RawEnvelope[] = [
  mk(0, "SessionStart", { session_id: "demo-session", model: "claude-opus-4-8" }),
  mk(800, "UserPromptSubmit", { session_id: "demo-session" }),

  mk(1500, "SubagentStart", { agent_id: "a-research", agent_type: "researcher" }),
  post(2200, "WebFetch", { url: "https://docs.anthropic.com/claude/agents" }, "fetched 18kb", "w1"),
  post(3000, "WebSearch", { query: "agent orchestration patterns" }, "8 results", "w2"),
  post(3800, "mcp__context7__query-docs", { library: "three.js" }, "x".repeat(4200), "c1"),
  mk(4500, "SubagentStop", { agent_id: "a-research" }),

  mk(5200, "SubagentStart", { agent_id: "a-build", agent_type: "implementer" }),
  post(5800, "Read", { file_path: "src/visualizer/graph.ts" }, "y".repeat(2600), "f1"),
  post(6600, "Write", { file_path: "webview/scene.ts" }, "wrote 312 lines", "f2"),
  post(7400, "Bash", { command: "npm run build:webview" }, "build ok", "b1"),
  post(8200, "mcp__github__create_pull_request", { title: "feat: theater" }, "pr #42", "c2"),
  mk(9000, "SubagentStop", { agent_id: "a-build" }),

  mk(9600, "SubagentStart", { agent_id: "a-review", agent_type: "reviewer" }),
  post(10200, "Read", { file_path: "webview/wires.ts" }, "z".repeat(1800), "f3"),
  post(11000, "Edit", { file_path: "webview/wires.ts" }, "applied", "f4"),
  mk(11800, "SubagentStop", { agent_id: "a-review" }),

  mk(12600, "Stop", { session_id: "demo-session" }),
];

/** Build the demo scene fresh on each call. */
export function demoScene(): Scene {
  const b = new GraphBuilder();
  for (const env of ENVELOPES) b.ingest(env);
  const scene = b.snapshot();
  // Overlay rich GitHub refs (titles/state) that inference alone can't supply.
  for (const node of scene.graph.nodes) {
    node.github = DEMO_REFS;
  }
  return scene;
}
