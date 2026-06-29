// Pure model types shared by the host data pipeline and the webview renderer.
// No runtime imports — the webview bundle pulls these in with `import type`, so
// nothing here may reference `vscode`, `fs`, or any Node API.

export type NodeKind = "session" | "agent" | "subagent";
export type ToolClass = "file" | "shell" | "web" | "cloud" | "spawn" | "other";

/** A GitHub issue or pull request linked to a node. */
export interface GitHubRef {
  kind: "issue" | "pr";
  number: number;
  url: string;
  /** Filled by host-side enrichment; absent when inference-only or offline. */
  title?: string;
  /** "open" | "closed" | "merged" — filled by host-side enrichment. */
  state?: string;
}

export interface GitHubRefs {
  repoUrl?: string; // https://github.com/owner/repo
  owner?: string;
  repo?: string;
  refs: GitHubRef[];
}

export interface GraphNode {
  id: string; // stable: "session" | "agent" | "sub:<agent_id>"
  kind: NodeKind;
  parentId?: string;
  label: string;
  agentType?: string;
  repo?: string;
  branch?: string;
  commit?: string;
  github?: GitHubRefs;
  tCreated: number; // ms epoch
  tEnded?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: "spawn";
  tCreated: number;
}

export interface ToolCall {
  id: string; // tool_use_id when present, else a synthetic "tc:<n>"
  nodeId: string; // the agent that issued the call
  toolName: string;
  cls: ToolClass;
  headline: string;
  target?: string; // url | file path | mcp server
  tStart: number;
  tEnd?: number;
  ok?: boolean;
  sizeBytes?: number; // response size → beam intensity/dwell
}

export interface OrchestrationGraph {
  sessionId: string;
  traceId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  toolCalls: ToolCall[];
  tStart: number;
  tEnd: number;
}

export type TimelineEventType =
  | "session_start"
  | "node_spawn"
  | "node_end"
  | "tool_start"
  | "tool_end";

export interface TimelineEvent {
  t: number; // ms epoch (real capture time)
  type: TimelineEventType;
  ref: string; // node id or tool-call id
}

export interface PlaybackTimeline {
  events: TimelineEvent[]; // sorted by t
  tStart: number;
  tEnd: number;
}

/** The full payload posted to the webview to render one session. */
export interface Scene {
  graph: OrchestrationGraph;
  timeline: PlaybackTimeline;
}
