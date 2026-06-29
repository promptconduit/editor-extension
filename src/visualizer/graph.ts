// GraphBuilder turns a stream of RawEnvelopes into an OrchestrationGraph +
// PlaybackTimeline. It is a stateful, incremental accumulator: `ingest(env)` one
// event at a time, `snapshot()` any time. v1 playback feeds it the whole history
// at once; a future live mode feeds it tail deltas and re-snapshots — same
// builder, same renderer. This is the seam that makes real-time additive.
//
// Pure (no Node/vscode). The orchestration model:
//   session ──spawn──> agent (the lead) ──spawn──> subagent*  (one per agent_id)
// Tool calls are attributed to the lead agent (Claude Code runs sub-agent tool
// calls inside the Task, so the main session's hook stream is the lead's work).
import type {
  GraphNode,
  GraphEdge,
  ToolCall,
  OrchestrationGraph,
  PlaybackTimeline,
  TimelineEvent,
  GitHubRefs,
} from "./types";
import { RawEnvelope, NativeToolCall, toolCallsOf } from "./envelope";
import { classifyTool, describeToolCall, inferGitHubRefs } from "./classify";

const SESSION_ID = "session";
const AGENT_ID = "agent";

function ms(iso: string, fallback: number): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? fallback : t;
}

function toolDisplay(tool: string): string {
  switch (tool) {
    case "claude-code":
      return "Claude Code";
    case "cursor":
      return "Cursor";
    case "gemini-cli":
      return "Gemini";
    case "codex":
      return "Codex";
    case "copilot":
      return "Copilot";
    default:
      return tool || "Agent";
  }
}

function sizeOf(resp: unknown): number | undefined {
  if (resp === undefined || resp === null) return undefined;
  try {
    return typeof resp === "string" ? resp.length : JSON.stringify(resp).length;
  } catch {
    return undefined;
  }
}

function isOk(resp: unknown): boolean {
  if (resp && typeof resp === "object") {
    const r = resp as Record<string, unknown>;
    if (r.is_error === true || r.error) return false;
  }
  return true;
}

export class GraphBuilder {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private calls = new Map<string, ToolCall>();
  private pendingById = new Map<string, ToolCall>(); // Pre seen, awaiting Post
  private timeline: TimelineEvent[] = [];
  private sessionId = "";
  private traceId = "";
  private github?: GitHubRefs;
  private lastT = 0;
  private tStart = Number.POSITIVE_INFINITY;
  private tEnd = 0;
  private synthSeq = 0;

  ingest(env: RawEnvelope): void {
    const t = ms(env.capturedAt, this.lastT + 1);
    this.lastT = t;
    this.tStart = Math.min(this.tStart, t);
    this.tEnd = Math.max(this.tEnd, t);

    this.ensureRoots(env, t);

    switch (env.hookEvent) {
      case "SubagentStart":
        this.onSubagentStart(env, t);
        break;
      case "SubagentStop":
        this.endNode(`sub:${asStr(env.native.agent_id)}`, t);
        break;
      case "Stop":
      case "SessionEnd":
        this.endNode(AGENT_ID, t);
        break;
      case "PreToolUse":
        this.onPre(env, t);
        break;
      case "PostToolUse":
      case "PostToolBatch":
        this.onPost(env, t, false);
        break;
      case "PostToolUseFailure":
        this.onPost(env, t, true);
        break;
      default:
        break;
    }
  }

  // Lazily create the session + lead-agent roots on the first event, capturing
  // repo/branch/commit and inferring GitHub refs once for the whole session.
  private ensureRoots(env: RawEnvelope, t: number): void {
    if (this.nodes.size > 0) return;
    this.sessionId = asStr(env.native.session_id);
    this.traceId = env.correlation.trace_id ?? "";
    this.github = inferGitHubRefs(env.git);
    const repo = env.git.repo_name;
    const common = { repo, branch: env.git.branch, commit: env.git.commit_hash, github: this.github };

    this.nodes.set(SESSION_ID, {
      id: SESSION_ID,
      kind: "session",
      label: repo || "Session",
      tCreated: t,
      ...common,
    });
    this.nodes.set(AGENT_ID, {
      id: AGENT_ID,
      kind: "agent",
      parentId: SESSION_ID,
      label: asStr(env.native.model) || toolDisplay(env.tool),
      tCreated: t,
      ...common,
    });
    this.edges.push({ from: SESSION_ID, to: AGENT_ID, kind: "spawn", tCreated: t });
    this.timeline.push({ t, type: "session_start", ref: SESSION_ID });
    this.timeline.push({ t, type: "node_spawn", ref: AGENT_ID });
  }

  private onSubagentStart(env: RawEnvelope, t: number): void {
    const agentId = asStr(env.native.agent_id);
    if (!agentId) return;
    const id = `sub:${agentId}`;
    if (this.nodes.has(id)) return;
    const agentType = asStr(env.native.agent_type);
    this.nodes.set(id, {
      id,
      kind: "subagent",
      parentId: AGENT_ID,
      label: agentType || "subagent",
      agentType: agentType || undefined,
      github: this.github,
      tCreated: t,
    });
    this.edges.push({ from: AGENT_ID, to: id, kind: "spawn", tCreated: t });
    this.timeline.push({ t, type: "node_spawn", ref: id });
  }

  private endNode(id: string, t: number): void {
    const n = this.nodes.get(id);
    if (n && n.tEnded === undefined) {
      n.tEnded = t;
      this.timeline.push({ t, type: "node_end", ref: id });
    }
  }

  private onPre(env: RawEnvelope, t: number): void {
    for (const c of toolCallsOf(env)) {
      const id = c.tool_use_id;
      // Without an id we can't pair Pre→Post; let the Post create the call to
      // avoid duplicates.
      if (!id || this.calls.has(id)) continue;
      const call = this.makeCall(id, c, t);
      this.pendingById.set(id, call);
      this.calls.set(id, call);
      this.timeline.push({ t, type: "tool_start", ref: id });
    }
  }

  private onPost(env: RawEnvelope, t: number, failure: boolean): void {
    for (const c of toolCallsOf(env)) {
      const id = c.tool_use_id;
      let call = id ? this.pendingById.get(id) : undefined;
      if (call && id) {
        this.pendingById.delete(id);
      } else {
        const cid = id || `tc:${this.synthSeq++}`;
        call = this.makeCall(cid, c, t);
        this.calls.set(cid, call);
        this.timeline.push({ t, type: "tool_start", ref: cid });
      }
      call.tEnd = t;
      call.ok = failure ? false : isOk(c.tool_response);
      const sz = sizeOf(c.tool_response);
      if (sz !== undefined) call.sizeBytes = sz;
      this.timeline.push({ t, type: "tool_end", ref: call.id });
    }
  }

  private makeCall(id: string, c: NativeToolCall, t: number): ToolCall {
    const toolName = c.tool_name || "";
    const { headline, target } = describeToolCall(toolName, c.tool_input);
    return {
      id,
      nodeId: AGENT_ID,
      toolName,
      cls: classifyTool(toolName),
      headline,
      target,
      tStart: t,
    };
  }

  snapshot(): { graph: OrchestrationGraph; timeline: PlaybackTimeline } {
    const tStart = this.tStart === Number.POSITIVE_INFINITY ? 0 : this.tStart;
    const tEnd = Math.max(this.tEnd, tStart);
    const events = this.timeline.slice().sort((a, b) => a.t - b.t);
    const graph: OrchestrationGraph = {
      sessionId: this.sessionId,
      traceId: this.traceId,
      nodes: [...this.nodes.values()],
      edges: this.edges.slice(),
      toolCalls: [...this.calls.values()],
      tStart,
      tEnd,
    };
    return { graph, timeline: { events, tStart, tEnd } };
  }
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Convenience: build a complete scene from a finished history (v1 playback). */
export function buildScene(envelopes: RawEnvelope[]): {
  graph: OrchestrationGraph;
  timeline: PlaybackTimeline;
} {
  const b = new GraphBuilder();
  for (const env of envelopes) b.ingest(env);
  return b.snapshot();
}
