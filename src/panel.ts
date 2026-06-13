import * as vscode from "vscode";
import { CostEvent, SessionSummary } from "./types";

function fmtUSD(n: number): string {
  return `$${n.toFixed(4)}`;
}

function num(n: number): string {
  return n.toLocaleString();
}

/**
 * CostPanel renders the click-through breakdown: session totals, per-model
 * rows, and the per-token detail (input / output / cache-read / cache-write).
 * A single reused webview; calling show() again refreshes it.
 */
export class CostPanel {
  private static current: CostPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;

  static show(session: SessionSummary | undefined, lastEvent: CostEvent | undefined): void {
    if (CostPanel.current && !CostPanel.current.disposed) {
      CostPanel.current.panel.reveal(vscode.ViewColumn.Active);
      CostPanel.current.update(session, lastEvent);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "promptconduitCost",
      "AI Cost Breakdown",
      vscode.ViewColumn.Active,
      { enableScripts: false, retainContextWhenHidden: true },
    );
    CostPanel.current = new CostPanel(panel);
    CostPanel.current.update(session, lastEvent);
  }

  /** Push fresh data into an already-open panel (called on new records). */
  static refresh(session: SessionSummary | undefined, lastEvent: CostEvent | undefined): void {
    if (CostPanel.current && !CostPanel.current.disposed) {
      CostPanel.current.update(session, lastEvent);
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

  private update(session: SessionSummary | undefined, lastEvent: CostEvent | undefined): void {
    this.panel.webview.html = this.html(session, lastEvent);
  }

  private html(session: SessionSummary | undefined, lastEvent: CostEvent | undefined): string {
    const t = session?.totals;
    const rows = (session?.by_model ?? [])
      .map(
        (m) => `
        <tr>
          <td>${escape(m.model)}</td>
          <td class="num">${num(m.tokens.input)}</td>
          <td class="num">${num(m.tokens.output)}</td>
          <td class="num">${num(m.tokens.cache_read)}</td>
          <td class="num">${num(m.tokens.cache_write)}</td>
          <td class="num">${fmtUSD(m.cost_total)}</td>
        </tr>`,
      )
      .join("");

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
  .total { font-size: 2rem; font-weight: 600; }
  .badge { display: inline-block; font-size: 0.75rem; padding: 0.1rem 0.5rem; border-radius: 0.5rem;
           background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-left: 0.5rem; }
  .muted { color: var(--vscode-descriptionForeground); }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--vscode-panel-border); }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  footer { margin-top: 1.5rem; }
</style>
</head>
<body>
  <h1>AI Session Cost <span class="badge">${escape(session?.source ?? "—")}</span></h1>
  <div class="total">${totalCost}</div>
  ${lastReq}
  <table>
    <thead>
      <tr>
        <th>Model</th><th class="num">Input</th><th class="num">Output</th>
        <th class="num">Cache read</th><th class="num">Cache write</th><th class="num">Cost</th>
      </tr>
    </thead>
    <tbody>
      ${rows || `<tr><td colspan="6" class="muted">No priced turns yet.</td></tr>`}
    </tbody>
  </table>
  <footer class="muted">
    Computed entirely on your machine from local transcripts. None of your data is sent anywhere.
  </footer>
</body>
</html>`;
  }
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
