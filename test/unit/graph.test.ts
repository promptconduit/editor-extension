import { describe, it, expect } from "vitest";
import { GraphBuilder, buildScene } from "../../src/visualizer/graph";
import type { RawEnvelope } from "../../src/visualizer/envelope";

let seq = 0;
function env(hookEvent: string, native: Record<string, unknown>, capturedAt?: string): RawEnvelope {
  seq += 1;
  return {
    tool: "claude-code",
    hookEvent,
    capturedAt: capturedAt ?? new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    native: native as RawEnvelope["native"],
    git: {
      repo_name: "demo",
      branch: "feat/3-x",
      commit_message: "work (Closes #9)",
      remote_url: "git@github.com:o/demo.git",
    },
    correlation: { trace_id: "t1", span_id: `s${seq}` },
  };
}

describe("GraphBuilder", () => {
  it("builds the session → agent → subagent spawn tree", () => {
    const b = new GraphBuilder();
    b.ingest(env("SessionStart", { session_id: "sess", model: "claude-opus-4-8" }));
    b.ingest(env("SubagentStart", { agent_id: "a1", agent_type: "researcher" }));
    b.ingest(env("SubagentStop", { agent_id: "a1" }));
    const { graph } = b.snapshot();

    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get("session")?.kind).toBe("session");
    expect(byId.get("agent")?.kind).toBe("agent");
    expect(byId.get("agent")?.parentId).toBe("session");
    expect(byId.get("agent")?.label).toBe("claude-opus-4-8");
    const sub = byId.get("sub:a1");
    expect(sub?.kind).toBe("subagent");
    expect(sub?.parentId).toBe("agent");
    expect(sub?.agentType).toBe("researcher");
    expect(sub?.tEnded).toBeGreaterThan(sub!.tCreated); // closed by SubagentStop

    // Edges: session→agent and agent→sub:a1
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: "session", to: "agent" }));
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: "agent", to: "sub:a1" }));
    expect(graph.sessionId).toBe("sess");
    expect(graph.traceId).toBe("t1");
  });

  it("attaches inferred GitHub refs to nodes", () => {
    const b = new GraphBuilder();
    b.ingest(env("SessionStart", { session_id: "s" }));
    const node = b.snapshot().graph.nodes[0];
    expect(node.github?.owner).toBe("o");
    expect(node.github?.refs.map((r) => r.number).sort((a, z) => a - z)).toEqual([3, 9]);
  });

  it("produces identical tool calls from PostToolUse and PostToolBatch", () => {
    const single = new GraphBuilder();
    single.ingest(env("SessionStart", { session_id: "s" }));
    single.ingest(
      env("PostToolUse", {
        tool_name: "Read",
        tool_input: { file_path: "a.ts" },
        tool_response: "hello",
        tool_use_id: "u1",
      }),
    );

    const batch = new GraphBuilder();
    batch.ingest(env("SessionStart", { session_id: "s" }));
    batch.ingest(
      env("PostToolBatch", {
        tool_calls: [
          { tool_name: "Read", tool_input: { file_path: "a.ts" }, tool_response: "hello", tool_use_id: "u1" },
        ],
      }),
    );

    const a = single.snapshot().graph.toolCalls;
    const z = batch.snapshot().graph.toolCalls;
    expect(a).toHaveLength(1);
    expect(z).toHaveLength(1);
    // Compare everything except timestamps (which differ by capture sequence).
    const strip = (c: (typeof a)[number]) => ({ ...c, tStart: 0, tEnd: 0 });
    expect(strip(a[0])).toEqual(strip(z[0]));
    expect(a[0].cls).toBe("file");
    expect(a[0].sizeBytes).toBe("hello".length);
    expect(a[0].ok).toBe(true);
  });

  it("classifies each tool class and flags failures", () => {
    const b = new GraphBuilder();
    b.ingest(env("SessionStart", { session_id: "s" }));
    b.ingest(env("PostToolUse", { tool_name: "WebFetch", tool_input: { url: "https://x" }, tool_response: "ok", tool_use_id: "w" }));
    b.ingest(env("PostToolUse", { tool_name: "mcp__gh__x", tool_input: {}, tool_response: "ok", tool_use_id: "c" }));
    b.ingest(env("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "ok", tool_use_id: "sh" }));
    b.ingest(
      env("PostToolUseFailure", {
        tool_name: "Read",
        tool_input: { file_path: "missing" },
        tool_response: { is_error: true },
        tool_use_id: "f",
      }),
    );
    const calls = b.snapshot().graph.toolCalls;
    const byTool = new Map(calls.map((c) => [c.toolName, c]));
    expect(byTool.get("WebFetch")?.cls).toBe("web");
    expect(byTool.get("mcp__gh__x")?.cls).toBe("cloud");
    expect(byTool.get("Bash")?.cls).toBe("shell");
    expect(byTool.get("Read")?.ok).toBe(false);
  });

  it("pairs Pre→Post by tool_use_id without duplicating", () => {
    const b = new GraphBuilder();
    b.ingest(env("SessionStart", { session_id: "s" }));
    b.ingest(env("PreToolUse", { tool_name: "Write", tool_input: { file_path: "a" }, tool_use_id: "p1" }));
    b.ingest(env("PostToolUse", { tool_name: "Write", tool_input: { file_path: "a" }, tool_response: "done", tool_use_id: "p1" }));
    const calls = b.snapshot().graph.toolCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0].tEnd).toBeGreaterThan(calls[0].tStart); // Pre set start, Post set end
  });

  it("incremental ingest then snapshot equals batch buildScene (the v1/v2 seam)", () => {
    const envelopes = [
      env("SessionStart", { session_id: "s", model: "m" }),
      env("SubagentStart", { agent_id: "a", agent_type: "r" }),
      env("PostToolUse", { tool_name: "Read", tool_input: { file_path: "x" }, tool_response: "y", tool_use_id: "u" }),
      env("SubagentStop", { agent_id: "a" }),
      env("Stop", { session_id: "s" }),
    ];
    const incremental = new GraphBuilder();
    for (const e of envelopes) incremental.ingest(e);
    expect(incremental.snapshot()).toEqual(buildScene(envelopes));
  });
});
