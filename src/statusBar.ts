import * as vscode from "vscode";
import { ConversationStore } from "./state";
import { CostEvent, SessionSummary } from "./types";

const SHOW_DETAILS_COMMAND = "promptconduit.cost.showDetails";

function fmtUSD(n: number): string {
  // Sub-cent precision for request cost; the tooltip shows full precision.
  if (n < 0.01) {
    return `$${n.toFixed(4)}`;
  }
  return `$${n.toFixed(2)}`;
}

function sourceBadge(source: string): string {
  switch (source) {
    case "exact":
      return "exact";
    case "estimate":
      return "~estimate";
    case "reconciled":
      return "reconciled";
    default:
      return source;
  }
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

// signalsSummary renders a one-line headline of the session's cost-reduction
// signals (CLI schema v2+) for the status-bar tooltip, so the key numbers show
// on hover without opening the full panel. Cache-hit rate is always included
// when signals exist; tier and tool-call volume are added only when meaningful.
// Returns "" when the session carries no signals (older CLI or no priced turns).
function signalsSummary(session: SessionSummary): string {
  const sig = session.signals;
  if (!sig) {
    return "";
  }
  const parts = [`cache hit ${pct(sig.cache_hit_rate)}`];
  if (sig.tier && sig.tier !== "unknown") {
    parts.push(`${sig.tier} tier`);
  }
  if (sig.tool_calls > 0) {
    parts.push(`${sig.tool_calls} tool call${sig.tool_calls === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

/**
 * CostStatusBar owns the bottom-right status bar item. It renders the latest
 * request cost and the running total of the MOST-RECENTLY-ACTIVE conversation
 * (Cursor per-tab `conversation_id`, falling back to `session_id` for Claude
 * Code), throttling UI writes so bursty turns don't thrash the bar.
 *
 * Per-conversation state lives in a ConversationStore; the bar, tooltip, and the
 * public getters consumed by the detail panel all read the ACTIVE conversation,
 * so the bar follows whichever agent tab produced the latest record (#7).
 */
export class CostStatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly store = new ConversationStore();
  private pending = false;
  private throttle: NodeJS.Timeout | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = SHOW_DETAILS_COMMAND;
    this.render();
  }

  get statusBarItem(): vscode.StatusBarItem {
    return this.item;
  }

  /** Session summary of the active conversation, for the detail panel. */
  get session(): SessionSummary | undefined {
    return this.store.activeSummary;
  }

  /** Latest request of the active conversation. */
  get lastRequest(): CostEvent | undefined {
    return this.store.activeLastEvent;
  }

  /** Recent turns (oldest first) of the active conversation, for the panel. */
  get recentRequests(): CostEvent[] {
    return this.store.activeRecent;
  }

  show(): void {
    this.item.show();
  }

  hide(): void {
    this.item.hide();
  }

  updateFromEvent(ev: CostEvent): void {
    this.store.recordEvent(ev);
    this.scheduleRender();
  }

  updateFromSummary(s: SessionSummary): void {
    this.store.recordSummary(s);
    this.scheduleRender();
  }

  private hasUnpriced(): boolean {
    return (this.store.activeSummary?.by_model ?? []).some((m) => !m.model_priced);
  }

  // The session cost shown in the bar: a dollar amount when we have priced
  // turns, or "unpriced" when there are tokens but no rate (e.g. Cursor
  // composer) so a real session never reads as a misleading "$0.00".
  private sessionCostLabel(): string {
    const s = this.store.activeSummary;
    if (!s) {
      return "$0.00";
    }
    if (s.totals.cost_total > 0) {
      return fmtUSD(s.totals.cost_total);
    }
    return this.hasUnpriced() ? "unpriced" : "$0.00";
  }

  private scheduleRender(): void {
    if (this.throttle) {
      this.pending = true;
      return;
    }
    this.render();
    this.throttle = setTimeout(() => {
      this.throttle = undefined;
      if (this.pending) {
        this.pending = false;
        this.render();
      }
    }, 250);
  }

  private render(): void {
    const lastEvent = this.store.activeLastEvent;
    const reqStr = lastEvent
      ? lastEvent.model_priced
        ? fmtUSD(lastEvent.cost.total)
        : "unpriced"
      : "—";

    const sessStr = this.sessionCostLabel();
    this.item.text = `$(zap) ${reqStr} · $(history) ${sessStr}`;

    const tip = new vscode.MarkdownString();
    tip.isTrusted = false;
    tip.appendMarkdown(`**AI session cost** _(100% local)_\n\n`);
    const activeSession = this.store.activeSummary;
    if (activeSession) {
      const s = activeSession;
      tip.appendMarkdown(`Session total: **${this.sessionCostLabel()}** _(${sourceBadge(s.source)})_\n\n`);
      for (const m of s.by_model) {
        const cost = m.model_priced ? fmtUSD(m.cost_total) : "tokens only — unpriced";
        tip.appendMarkdown(`- ${m.model}: ${cost}\n`);
      }
      if (this.hasUnpriced()) {
        tip.appendMarkdown(`\n_Some models have no rate in the table — exact tokens shown, cost not computed._\n`);
      }
      tip.appendMarkdown(
        `\nTokens — in ${s.totals.input.toLocaleString()}, out ${s.totals.output.toLocaleString()}, ` +
          `cache read ${s.totals.cache_read.toLocaleString()}, cache write ${s.totals.cache_write.toLocaleString()}\n`,
      );
      const signals = signalsSummary(s);
      if (signals) {
        tip.appendMarkdown(`\n${signals}\n`);
      }
    } else {
      tip.appendMarkdown(`No priced turns yet this session.\n`);
    }
    if (lastEvent) {
      tip.appendMarkdown(`\nLast request: ${fmtUSD(lastEvent.cost.total)} (${lastEvent.model})\n`);
    }
    tip.appendMarkdown(`\n_Click for the full breakdown._`);
    this.item.tooltip = tip;
  }

  dispose(): void {
    if (this.throttle) {
      clearTimeout(this.throttle);
    }
    this.item.dispose();
  }
}
