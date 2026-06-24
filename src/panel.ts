import * as vscode from "vscode";
import { CostEvent, SessionSummary, ToolSummary } from "./types";
import { buildTips } from "./tips";

function fmtUSD(n: number): string {
  return `$${n.toFixed(4)}`;
}

function num(n: number): string {
  return n.toLocaleString();
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

// "Read ×3, Bash ×2" from a ToolSummary, or "" when there are no names.
function toolList(tools: ToolSummary | undefined): string {
  if (!tools?.by_name) {
    return "";
  }
  return Object.entries(tools.by_name)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${escape(name)} ×${n}`)
    .join(", ");
}

function shortTime(ts: string): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? escape(ts) : d.toLocaleTimeString();
}

/**
 * CostPanel renders the click-through breakdown: session totals, cost-reduction
 * tips, per-model rows, and a per-request drill-down (tools / tokens / cost).
 * A single reused webview; calling show() again refreshes it. Uses pure HTML
 * (<details>) for expandable rows so it works with scripts disabled.
 */
export class CostPanel {
  private static current: CostPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;

  static show(
    session: SessionSummary | undefined,
    lastEvent: CostEvent | undefined,
    recent: CostEvent[] = [],
  ): void {
    if (CostPanel.current && !CostPanel.current.disposed) {
      CostPanel.current.panel.reveal(vscode.ViewColumn.Active);
      CostPanel.current.update(session, lastEvent, recent);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "promptconduitCost",
      "AI Cost Breakdown",
      vscode.ViewColumn.Active,
      { enableScripts: false, retainContextWhenHidden: true },
    );
    CostPanel.current = new CostPanel(panel);
    CostPanel.current.update(session, lastEvent, recent);
  }

  /** Push fresh data into an already-open panel (called on new records). */
  static refresh(
    session: SessionSummary | undefined,
    lastEvent: CostEvent | undefined,
    recent: CostEvent[] = [],
  ): void {
    if (CostPanel.current && !CostPanel.current.disposed) {
      CostPanel.current.update(session, lastEvent, recent);
    }
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => {
      this.disposed = true;
      if (CostPanel.current === this) {
        CostPanel.current = undefined;
      }
    });
  }

  private update(
    session: SessionSummary | undefined,
    lastEvent: CostEvent | undefined,
    recent: CostEvent[],
  ): void {
    this.panel.webview.html = this.html(session, lastEvent, recent);
  }

  private html(
    session: SessionSummary | undefined,
    lastEvent: CostEvent | undefined,
    recent: CostEvent[],
  ): string {
    const t = session?.totals;
    const models = session?.by_model ?? [];
    const anyUnpriced = models.some((m) => !m.model_priced);

    const rows = models
      .map(
        (m) => `
        <tr>
          <td>${escape(m.model)}${m.model_priced ? "" : ' <span class="badge">unpriced</span>'}</td>
          <td class="num">${num(m.tokens.input)}</td>
          <td class="num">${num(m.tokens.output)}</td>
          <td class="num">${num(m.tokens.cache_read)}</td>
          <td class="num">${num(m.tokens.cache_write)}</td>
          <td class="num">${m.model_priced ? fmtUSD(m.cost_total) : "—"}</td>
        </tr>`,
      )
      .join("");
    const unpricedNote = anyUnpriced
      ? `<p class="muted">Models marked <em>unpriced</em> aren't in the rate table (e.g. Cursor's composer models). Exact tokens are shown; add a per-token rate to compute their cost.</p>`
      : "";

    const totalCost = t ? fmtUSD(t.cost_total) : "$0.0000";
    const lastReq = lastEvent
      ? `<p class="muted">Last request: <strong>${fmtUSD(lastEvent.cost.total)}</strong> — ${escape(lastEvent.model)} ${lastEvent.model_priced ? "" : "(unpriced model)"}</p>`
      : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 1rem 1.25rem; }
  h1 { font-size: 1.1rem; margin: 0 0 0.25rem; }
  h2 { font-size: 0.95rem; margin: 1.5rem 0 0.5rem; }
  .total { font-size: 2rem; font-weight: 600; }
  .badge { display: inline-block; font-size: 0.75rem; padding: 0.1rem 0.5rem; border-radius: 0.5rem;
           background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-left: 0.5rem; }
  .muted { color: var(--vscode-descriptionForeground); }
  table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--vscode-panel-border); }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .tips { margin-top: 0.5rem; padding: 0; list-style: none; }
  .tips li { padding: 0.5rem 0.75rem; margin-bottom: 0.4rem; border-left: 3px solid var(--vscode-textLink-foreground);
             background: var(--vscode-textBlockQuote-background); border-radius: 0 0.25rem 0.25rem 0; }
  .tips strong { display: block; }
  details { border-bottom: 1px solid var(--vscode-panel-border); padding: 0.35rem 0; }
  summary { cursor: pointer; font-variant-numeric: tabular-nums; }
  .drill { margin: 0.4rem 0 0.2rem 1rem; font-size: 0.9rem; }
  .drill span { display: inline-block; margin-right: 1rem; }
  footer { margin-top: 1.5rem; }
</style>
</head>
<body>
  <h1>AI Session Cost <span class="badge">${escape(session?.source ?? "—")}</span></h1>
  <div class="total">${totalCost}</div>
  ${lastReq}

  ${this.tipsHtml(session, lastEvent)}

  <h2>By model</h2>
  <table>
    <thead>
      <tr>
        <th>Model</th><th class="num">Input</th><th class="num">Output</th>
        <th class="num">Cache read</th><th class="num">Cache write</th><th class="num">Cost</th>
      </tr>
    </thead>
    <tbody>
      ${rows || `<tr><td colspan="6" class="muted">No turns yet.</td></tr>`}
    </tbody>
  </table>
  ${unpricedNote}

  ${this.recentHtml(recent)}

  <footer class="muted">
    Computed entirely on your machine from local transcripts. None of your data is sent anywhere.
  </footer>
</body>
</html>`;
  }

  private tipsHtml(
    session: SessionSummary | undefined,
    lastEvent: CostEvent | undefined,
  ): string {
    const tips = buildTips(session, lastEvent);
    if (tips.length === 0) {
      return "";
    }
    const items = tips
      .map((tip) => `<li><strong>${escape(tip.title)}</strong>${escape(tip.detail)}</li>`)
      .join("");
    return `<h2>Reduce your cost</h2><ul class="tips">${items}</ul>`;
  }

  private recentHtml(recent: CostEvent[]): string {
    if (!recent || recent.length === 0) {
      return "";
    }
    // Newest first.
    const rows = [...recent]
      .reverse()
      .map((ev) => {
        const cost = ev.model_priced ? fmtUSD(ev.cost.total) : "unpriced";
        const tools = toolList(ev.tools);
        const toolCount = ev.tools?.total ?? 0;
        const tier = ev.signals?.tier && ev.signals.tier !== "unknown" ? ` · ${escape(ev.signals.tier)}` : "";
        const summary =
          `${cost} · ${escape(ev.model)}${tier} · ${toolCount} tool${toolCount === 1 ? "" : "s"} · ${shortTime(ev.ts)}`;
        const cacheLine =
          ev.signals !== undefined
            ? `<span>cache hit ${pct(ev.signals.cache_hit_rate)}</span><span>fresh input ${pct(ev.signals.input_token_share)}</span>`
            : "";
        const toolsLine = tools ? `<div class="drill muted">tools: ${tools}</div>` : "";
        return `
        <details>
          <summary>${summary}</summary>
          <div class="drill">
            <span>in ${num(ev.tokens.input)}</span><span>out ${num(ev.tokens.output)}</span>
            <span>cache read ${num(ev.tokens.cache_read)}</span><span>cache write ${num(ev.tokens.cache_write)}</span>
          </div>
          <div class="drill muted">${cacheLine}</div>
          ${toolsLine}
        </details>`;
      })
      .join("");
    return `<h2>Recent requests</h2>${rows}`;
  }
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
