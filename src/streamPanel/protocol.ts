// Message contract between the extension host and the Stream webview.
// Type-only on both sides (import type) so neither bundle drags the other's
// runtime in. Everything in StreamPanelState must survive JSON serialization —
// plain objects/arrays only, no Map/Set/Date.

import type { StreamEvent } from "../streamFeed";

export interface StreamPanelState {
  /** Monotonic push counter (client sanity/diffing). */
  revision: number;
  /** True when the user pinned a session (auto-follow is suspended). */
  pinned: boolean;
  /** True when the local event log is disabled (PROMPTCONDUIT_EVENT_LOG=0). */
  logDisabled: boolean;
  /** The followed session, or undefined when nothing has streamed yet. */
  session?: { key: string; tool: string; keyIsConversationId: boolean; count: number };
  /** Newest LAST in the buffer; the client renders newest first. */
  events: StreamEvent[];
}

export type HostMessage = { type: "state"; state: StreamPanelState };

export type WebviewMessage =
  | { type: "ready" }
  | { type: "open_external"; url: string }
  | { type: "command"; id: "pinSession" | "followActive" | "refresh" };
