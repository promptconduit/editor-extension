import * as vscode from "vscode";
import { ConversationStore, ConversationView, FocusSource } from "./state";
import { CostEvent, SessionSummary } from "./types";
import { EnvelopeV2 } from "./envelope";
import { shortId } from "./streamFeed";

const SHOW_DETAILS_COMMAND = "promptconduit.cost.showDetails";

export function fmtUSD(n: number): string {
  if (n < 0.01) {
    return `$${n.toFixed(4)}`;
  }
  return `$${n.toFixed(2)}`;
}

/** Cost label for a single request — never "$0.0000" for an unpriced model. */
export function lastRequestLabel(ev: CostEvent): string {
  return ev.model_priced ? fmtUSD(ev.cost.total) : "unpriced";
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

export function signalsSummary(session: SessionSummary): string {
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

function focusNote(source: FocusSource): string {
  switch (source) {
    case "prompted":
      return "_Following the session you last prompted._";
    case "terminal":
      return "_Following the focused terminal's Claude Code session._";
    case "pinned":
      return "_Pinned — not following your latest prompt._";
    case "activity":
      return "_Reflects the most recently active conversation, not necessarily the panel you're viewing._";
  }
}

/**
 * CostStatusBar owns the bottom-right status bar item. It renders the displayed
 * conversation (terminal focus, pin, or debounced activity) and exposes store
 * getters for the breakdown panels.
 */
export class CostStatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly store = new ConversationStore();
  private pending = false;
  private throttle: NodeJS.Timeout | undefined;
  private onChange: (() => void) | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = SHOW_DETAILS_COMMAND;
    this.store.setOnActiveDebounced(() => this.scheduleRender());
    this.render();
  }

  get statusBarItem(): vscode.StatusBarItem {
    return this.item;
  }

  /** Register a callback when display selection or totals change. */
  setOnChange(fn: () => void): void {
    this.onChange = fn;
  }

  get storeRef(): ConversationStore {
    return this.store;
  }

  get session(): SessionSummary | undefined {
    return this.store.displaySummary;
  }

  get lastRequest(): CostEvent | undefined {
    return this.store.displayLastEvent;
  }

  get recentRequests(): CostEvent[] {
    return this.store.displayRecent;
  }

  get conversations(): ConversationView[] {
    return this.store.list();
  }

  get displayConversationKey(): string | undefined {
    return this.store.displayKey;
  }

  /** @deprecated Use displayConversationKey */
  get activeConversationKey(): string | undefined {
    return this.store.displayKey;
  }

  get focusSource(): FocusSource {
    return this.store.focusSource;
  }

  get isPinned(): boolean {
    return this.store.pinnedKey !== undefined && this.store.focusSource === "pinned";
  }

  // render() already fires onChange — no extra call, one repaint per change.
  setFocusedKey(key: string | undefined): void {
    this.store.setFocusedKey(key);
    this.render();
  }

  pinSession(key: string): void {
    this.store.setPinnedKey(key);
    this.store.setFocusedKey(undefined);
    this.render();
  }

  followActive(): void {
    this.store.clearPin();
    this.render();
  }

  async pickAndPin(): Promise<void> {
    const sessions = this.store.list();
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage("No sessions yet — run an AI coding session first.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: `${s.tool || "session"} · ${shortId(s.key)}`,
        description: fmtUSD(s.summary.totals.cost_total),
        key: s.key,
      })),
      { placeHolder: "Pin cost breakdown to a session (stops auto-following)" },
    );
    if (pick) {
      this.pinSession(pick.key);
    }
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

  updateFromEnvelope(env: EnvelopeV2): void {
    this.store.recordEnvelope(env);
    this.scheduleRender();
  }

  private hasUnpriced(): boolean {
    return (this.store.displaySummary?.by_model ?? []).some((m) => !m.model_priced);
  }

  private sessionCostLabel(): string {
    const s = this.store.displaySummary;
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
    const lastEvent = this.store.displayLastEvent;
    const reqStr = lastEvent ? lastRequestLabel(lastEvent) : "—";

    const sessStr = this.sessionCostLabel();
    this.item.text = `$(zap) ${reqStr} · $(history) ${sessStr}`;

    const tip = new vscode.MarkdownString();
    tip.isTrusted = false;
    tip.appendMarkdown(`**AI session cost** _(100% local)_\n\n`);
    const displayKey = this.store.displayKey;
    if (displayKey) {
      const view = this.store.viewForKey(displayKey);
      const tool = view?.tool ? `${view.tool} · ` : "";
      const repo = view?.vcs?.repo ? ` · ${view.vcs.repo}` : "";
      tip.appendMarkdown(`${tool}\`${shortId(displayKey)}\`${repo}\n\n`);
    }
    tip.appendMarkdown(`${focusNote(this.store.focusSource)}\n\n`);
    const displaySession = this.store.displaySummary;
    if (displaySession) {
      const s = displaySession;
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
      tip.appendMarkdown(`\nLast request: ${lastRequestLabel(lastEvent)} (${lastEvent.model})\n`);
    }
    tip.appendMarkdown(
      `\n_Cursor tabs can't be auto-detected — this follows the session you last prompted. Pin to lock it._\n`,
    );
    tip.appendMarkdown(`\n_Click for the displayed session's breakdown._`);
    this.item.tooltip = tip;
    this.onChange?.();
  }

  dispose(): void {
    if (this.throttle) {
      clearTimeout(this.throttle);
    }
    this.store.dispose();
    this.item.dispose();
  }
}
