// Pure builder: ConversationStore -> CostPanelState. No vscode import so the
// whole panel state is unit-testable; the host serializes the result straight
// into webview.postMessage.

import { ConversationStore, ConversationView } from "../state";
import { buildTips } from "../tips";
import { buildEdgeCases } from "../edgeCases";
import { learnMoreLinks } from "../links";
import { CostPanelState, SessionView } from "./protocol";

let revision = 0;

function toSessionView(v: ConversationView, isActive: boolean): SessionView {
  return {
    key: v.key,
    tool: v.tool,
    summary: v.summary,
    lastEvent: v.lastEvent,
    prompts: v.prompts ?? [],
    droppedRequests: v.droppedRequests,
    droppedPrompts: v.droppedPrompts ?? 0,
    diff: v.diff,
    subagents: v.subagents,
    vcs: v.vcs,
    isActive,
    lastActivity: v.lastActivity,
  };
}

/**
 * Build the full panel state for one push. mode "session" carries only the
 * displayed conversation (empty sessions -> the client renders the landing
 * zero-state); mode "all" carries every conversation, most recent first.
 */
export function buildCostPanelState(
  store: ConversationStore,
  mode: "session" | "all",
): CostPanelState {
  const displayKey = store.displayKey;
  const display = displayKey ? store.viewForKey(displayKey) : undefined;

  let sessions: SessionView[];
  if (mode === "session") {
    sessions = display ? [toSessionView(display, true)] : [];
  } else {
    sessions = store.list().map((v) => toSessionView(v, v.key === displayKey));
  }

  revision += 1;
  return {
    mode,
    revision,
    sessions,
    focusSource: store.focusSource,
    tips: buildTips(display?.summary, display?.lastEvent),
    edgeCases: buildEdgeCases(display?.summary, display?.lastEvent),
    links: learnMoreLinks(display?.tool),
  };
}
