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
import type { CostScope, ScopeChip, ScopeTotals } from "../costScope";
import type { ModelPrice } from "../pricing";

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
  /** Active cost scope (session / branch / PR). */
  scope: CostScope;
  scopeChips: ScopeChip[];
  scopeTotals: ScopeTotals;
  /** Highest-signal coaching tip for the displayed conversation. */
  topTip?: Tip;
  /** Host-derived coaching content for the displayed conversation (advanced drawer). */
  tips: Tip[];
  edgeCases: EdgeCase[];
  links: ResourceLink[];
  /**
   * Set when the user has enough locally priced sessions to see value and is
   * not already syncing. The panel offers `promptconduit login`.
   */
  syncOffer?: SyncOffer;
  /**
   * Published PromptConduit rate card, per-token USD, when it is as new as the
   * rates bundled in this extension. Absent means the bundled table is used.
   */
  rateCard?: Record<string, ModelPrice>;
}

/** Local 30-day API-equivalent spend, shown as the reason to sign in. */
export interface SyncOffer {
  usd: number;
  sessions: number;
  windowDays: number;
}

export type HostMessage =
  | { type: "state"; state: CostPanelState }
  | { type: "visibility"; visible: boolean };

export type WebviewCommand =
  | "pinSession"
  | "followActive"
  | "showAll"
  | "showSession"
  | "refresh"
  | "openStream"
  | "openGraph"
  | "openAllSessions"
  | "setScope"
  | "login"
  | "dismissLogin";

export type WebviewMessage =
  | { type: "ready" }
  | { type: "open_external"; url: string }
  | { type: "command"; id: WebviewCommand; scope?: CostScope }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string };
