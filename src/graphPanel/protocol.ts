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

// ---- shared detail shapes (populated for the click-to-inspect side panel) ----

/** Token counts by category. cacheRead is the "memory" the model reused. */
export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** USD spend by the same categories, plus the total. */
export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/**
 * Prompt-cache ("memory") stats. hitRate is cacheRead / (cacheRead + input);
 * savingsUsd is the estimated spend avoided by serving cacheRead tokens from
 * cache instead of as fresh input (derived from each request's own input rate,
 * so it's grounded in real prices, not a fixed multiplier). Undefined when no
 * request had a derivable input rate.
 */
export interface CacheStats {
  hitRate?: number;
  readTokens: number;
  writeTokens: number;
  savingsUsd?: number;
}

/** One tool aggregated across a turn/session: how many calls, how many failed. */
export interface ToolStat {
  name: string;
  count: number;
  failed: number;
  totalMs?: number;
  mcpServer?: string;
  skill?: string;
  agentType?: string;
}

/** A permission prompt the agent hit. */
export interface PermissionEntry {
  decision: string;
  toolName?: string;
  mcpServer?: string;
}

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
  // ---- detail (side panel) ----
  requests?: number;
  /** Peak concurrent subagents when this one started (parallelism signal). */
  concurrent?: number;
  orphanStop?: boolean;
  tokens?: TokenBreakdown;
  cache?: CacheStats;
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
  // ---- detail (side panel) ----
  /** Full prompt text (not the truncated label). */
  promptFull?: string;
  permissionMode?: string;
  promptChars?: number;
  promptWords?: number;
  hasAttachments?: boolean;
  /** Distinct models the lead used this turn. */
  models?: string[];
  /** Number of priced model requests in the turn. */
  requests?: number;
  /** Lead token spend (excludes subagents, which carry their own). */
  tokens?: TokenBreakdown;
  cost?: CostBreakdown;
  cache?: CacheStats;
  /** Every tool used this turn, aggregated by name (not just the top chips). */
  toolStats?: ToolStat[];
  mcpServers?: string[];
  skills?: string[];
  permissions?: PermissionEntry[];
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
  // ---- detail (side panel) ----
  cwd?: string;
  host?: string;
  os?: string;
  arch?: string;
  /** Wall-clock from first event to last activity, ms. */
  durationMs?: number;
  /** Distinct models seen across the session. */
  models?: string[];
  /** Session token + cost totals across every turn (lead + subagents). */
  tokens?: TokenBreakdown;
  cost?: CostBreakdown;
  cache?: CacheStats;
  /** Every tool used this session, aggregated by name. */
  toolStats?: ToolStat[];
  mcpServers?: string[];
  skills?: string[];
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
