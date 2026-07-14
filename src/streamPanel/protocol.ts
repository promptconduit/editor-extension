// Message contract between the extension host and the Stream webview.
// Type-only on both sides (import type) so neither bundle drags the other's
// runtime in. Everything in StreamPanelState must survive JSON serialization —
// plain objects/arrays only, no Map/Set/Date.

import type { StreamEvent } from "../streamFeed";

/** Selection gestures that can auto-drill the stream (followSelection). */
export type SelectionSource = "terminal" | "cursor-tab";

export interface StreamPanelState {
  /** Monotonic push counter (client sanity/diffing). */
  revision: number;
  /**
   * "all" = the unified feed (every session interleaved); "session" = drilled
   * into the one carried in `session`.
   */
  viewMode: "all" | "session";
  /** True when the local event log is disabled (PROMPTCONDUIT_EVENT_LOG=0). */
  logDisabled: boolean;
  /** Live session buffers, for the "N live sessions" header line. */
  sessionCount: number;
  /** The drilled session; undefined in the unified ("all") view. */
  session?: { key: string; tool: string; keyIsConversationId: boolean; count: number };
  /**
   * Present when the drilled view was chosen by a selection gesture (focused
   * terminal / selected Cursor agent tab) rather than a manual drill.
   */
  selected?: SelectionSource;
  /**
   * Newest LAST; the client renders newest first. In "all" mode these are
   * interleaved across sessions (each row carries its own sessionKey/tool).
   */
  events: StreamEvent[];
}

export type HostMessage = { type: "state"; state: StreamPanelState };

export type WebviewMessage =
  | { type: "ready" }
  | { type: "open_external"; url: string }
  | { type: "drill"; key: string }
  | { type: "command"; id: "drillIn" | "showAll" | "refresh" };
