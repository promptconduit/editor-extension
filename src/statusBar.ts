import * as vscode from "vscode";
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

/**
 * CostStatusBar owns the bottom-right status bar item. It renders the latest
 * request cost and the active session's running total, throttling UI writes so
 * bursty turns don't thrash the bar.
 */
export class CostStatusBar {
  private static readonly MAX_RECENT = 50;
  private readonly item: vscode.StatusBarItem;
  private lastEvent: CostEvent | undefined;
  private activeSession: SessionSummary | undefined;
  // Bounded, request_id-deduped history of recent turns for the drill-down
  // panel (oldest first). The CLI dedups by request_id too, but Cursor emits
  // two events per generation, so we guard here as well.
  private recent: CostEvent[] = [];
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

  /** The most recently observed session summary, for the detail panel. */
  get session(): SessionSummary | undefined {
    return this.activeSession;
  }

  get lastRequest(): CostEvent | undefined {
    return this.lastEvent;
  }

  /** Recent turns (oldest first) for the drill-down panel. */
  get recentRequests(): CostEvent[] {
    return this.recent;
  }

  show(): void {
    this.item.show();
  }

  hide(): void {
    this.item.hide();
  }

  updateFromEvent(ev: CostEvent): void {
    this.lastEvent = ev;
    this.recordRecent(ev);
    this.scheduleRender();
  }

  // Append (or replace, by request_id) into the bounded recent history.
  private recordRecent(ev: CostEvent): void {
    if (ev.request_id) {
      const i = this.recent.findIndex((e) => e.request_id === ev.request_id);
      if (i >= 0) {
        this.recent[i] = ev;
        return;
      }
    }
    this.recent.push(ev);
    if (this.recent.length > CostStatusBar.MAX_RECENT) {
      this.recent.shift();
    }
  }

  updateFromSummary(s: SessionSummary): void {
    // Treat the most-recently-updated session as the active one.
    if (
      !this.activeSession ||
      s.session_id === this.activeSession.session_id ||
      s.updated_at >= this.activeSession.updated_at
    ) {
      this.activeSession = s;
    }
    this.scheduleRender();
  }

  private hasUnpriced(): boolean {
    return (this.activeSession?.by_model ?? []).some((m) => !m.model_priced);
  }

  // The session cost shown in the bar: a dollar amount when we have priced
  // turns, or "unpriced" when there are tokens but no rate (e.g. Cursor
  // composer) so a real session never reads as a misleading "$0.00".
  private sessionCostLabel(): string {
    const s = this.activeSession;
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
    const reqStr = this.lastEvent
      ? this.lastEvent.model_priced
        ? fmtUSD(this.lastEvent.cost.total)
        : "unpriced"
      : "—";

    const sessStr = this.sessionCostLabel();
    this.item.text = `$(zap) ${reqStr} · $(history) ${sessStr}`;

    const tip = new vscode.MarkdownString();
    tip.isTrusted = false;
    tip.appendMarkdown(`**AI session cost** _(100% local)_\n\n`);
    if (this.activeSession) {
      const s = this.activeSession;
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
    } else {
      tip.appendMarkdown(`No priced turns yet this session.\n`);
    }
    if (this.lastEvent) {
      tip.appendMarkdown(`\nLast request: ${fmtUSD(this.lastEvent.cost.total)} (${this.lastEvent.model})\n`);
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
