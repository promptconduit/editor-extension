// Message contract between the extension host and the Cost Breakdown webview.
// Type-only on both sides (import type) so neither bundle drags the other's
// runtime in. Everything in CostPanelState must survive JSON serialization —
// plain objects/arrays only, no Map/Set/Date.

import type { CostEvent, SessionSummary } from "../types";
import type { DiffEnrichment, VCSEnrichment } from "../envelope";
import type { PromptGroup } from "../promptGroup";
import type { SessionSubagentSummary, FocusSource } from "../state";
import type { Tip } from "../tips";
import type { EdgeCase } from "../edgeCases";
import type { ResourceLink } from "../links";

/** One conversation, fully prepared for rendering. */
export interface SessionView {
  key: string;
  tool: string;
  summary: SessionSummary;
  lastEvent?: CostEvent;
  /** Per-prompt groups in append order; the client renders newest-first. */
  prompts: PromptGroup[];
  /** Requests/groups evicted by memory caps (still counted in totals). */
  droppedRequests: number;
  droppedPrompts: number;
  diff?: DiffEnrichment;
  subagents?: SessionSubagentSummary;
  vcs?: VCSEnrichment;
  /** True when this is the displayed (focused/pinned/active) conversation. */
  isActive: boolean;
  lastActivity: number;
}

export interface CostPanelState {
  mode: "session" | "all";
  /** Monotonic push counter (client sanity/diffing). */
  revision: number;
  /** mode "session": zero or one entry. mode "all": every conversation. */
  sessions: SessionView[];
  /** How the displayed conversation was chosen (terminal / pinned / activity). */
  focusSource: FocusSource;
  /** Host-derived coaching content for the displayed conversation. */
  tips: Tip[];
  edgeCases: EdgeCase[];
  links: ResourceLink[];
}

export type HostMessage =
  | { type: "state"; state: CostPanelState }
  | { type: "visibility"; visible: boolean };

export type WebviewCommand =
  | "pinSession"
  | "followActive"
  | "showAll"
  | "showSession"
  | "refresh";

export type WebviewMessage =
  | { type: "ready" }
  | { type: "open_external"; url: string }
  | { type: "command"; id: WebviewCommand }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string };
