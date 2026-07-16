// Message contract between the extension host and the Session Graph webview.
// Type-only on both sides (import type) so neither bundle drags the other's
// runtime in. Everything in GraphPanelState must survive JSON serialization —
// plain objects/arrays only, no Map/Set/Date.
//
// This state shape is deliberately PORTABLE: it has no vscode or filesystem
// concepts, so any future surface (the platform web app, a CLI-served page)
// can render the same graph by emitting the same GraphPanelState.

/** How a node is doing right now — drives color and the "breathing" pulse. */
export type NodeState = "running" | "completed" | "failed" | "interrupted";

/** One session in the header picker, newest activity first. */
export interface SessionPickerItem {
  key: string;
  tool: string;
  repo?: string;
  branch?: string;
  /** Epoch ms of the newest event. */
  lastActivity: number;
  live: boolean;
  turnCount: number;
}

/** A subagent run nested under its turn. */
export interface GraphSubagentNode {
  agentId: string;
  agentType: string;
  state: NodeState;
  durationMs?: number;
  usdTotal?: number;
  model?: string;
  /** Ran in a different worktree than the session itself. */
  worktreeBadge?: boolean;
  worktreePath?: string;
}

/** Tool activity aggregated per turn (counts, not individual calls). */
export interface GraphTurnTools {
  total: number;
  failed: number;
  /** Top tools by call count, e.g. [{ name: "Read", count: 12, failed: 0 }]. */
  top: { name: string; count: number; failed: number }[];
}

/** One prompt→Stop turn under the session root. */
export interface GraphTurnNode {
  id: string;
  kind: "prompt" | "uncaptured" | "preamble";
  /** Truncated prompt text for the box label (undefined for uncaptured/preamble). */
  promptText?: string;
  state: NodeState;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  tools: GraphTurnTools;
  subagents: GraphSubagentNode[];
  /** Lead requests + subagent totals for this turn, USD. */
  usdTotal?: number;
  /** Ran in a different worktree than the session itself. */
  worktreeBadge?: boolean;
  worktreePath?: string;
}

/** The session root node. */
export interface GraphSessionNode {
  key: string;
  tool: string;
  repo?: string;
  branch?: string;
  model?: string;
  live: boolean;
  ended: boolean;
  startedAt?: string;
  /** Epoch ms of the newest event. */
  lastActivity: number;
  /** The session itself runs inside a worktree. */
  worktreePath?: string;
  turns: GraphTurnNode[];
  /** Turns evicted past the store cap (rendered as an "N earlier turns" stub). */
  droppedTurns: number;
  /** Session cost so far: every turn's usdTotal summed. */
  usdTotal?: number;
}

export interface GraphPanelState {
  /** Monotonic push counter (client sanity/diffing). */
  revision: number;
  /** True when the local event log is disabled (PROMPTCONDUIT_EVENT_LOG=0). */
  logDisabled: boolean;
  /** Recent sessions for the picker, newest activity first. */
  sessions: SessionPickerItem[];
  selectedKey?: string;
  /** The selected session's tree; undefined when no sessions exist yet. */
  session?: GraphSessionNode;
}

export type HostMessage = { type: "state"; state: GraphPanelState };

export type WebviewMessage =
  | { type: "ready" }
  | { type: "pickSession"; key: string }
  | { type: "command"; id: "refresh" };
