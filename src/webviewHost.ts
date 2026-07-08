// Shared helpers for the extension's *scripted* webviews (the Orchestration
// Theater visualizer, the cost breakdown detail report, …). The read-only
// cost/telemetry views run with enableScripts:false and need none of this; a
// scripted panel instead needs the trio below — a per-load nonce, a strict CSP
// built around it, and the html document shell that wires the esbuild bundle in
// via a nonce'd <script>. Extracted from visualizerPanel.ts so every scripted
// panel emits the exact same security envelope instead of hand-rolling it.
//
// All functions are pure (no vscode API calls at runtime — the vscode import is
// type-only), so they unit-test without an editor.

import type * as vscode from "vscode";
import { randomBytes } from "crypto";

// Gate for `open_external` messages arriving *from* a webview: only absolute
// http(s) URLs may reach vscode.env.openExternal. Reuses the cost panel's
// canonical checker so there is one definition of "safe URL" in the extension.
export { isSafeHttpUrl } from "./links";

/** Fresh 128-bit hex nonce for a single webview HTML load. */
export function makeNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * The strict Content-Security-Policy meta content for a scripted webview:
 * deny-by-default, script only via the per-load nonce (no 'unsafe-eval', no
 * remote script), styles/images/fonts only from the webview origin, and no
 * network access from the page — the extension host owns all data + network.
 */
export function webviewCsp(webview: vscode.Webview, nonce: string): string {
  return [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
    `connect-src 'none'`,
  ].join("; ");
}

/** Options for {@link webviewShellHtml}. */
export interface WebviewShellOptions {
  /** CSP meta content, normally from {@link webviewCsp}. */
  csp: string;
  /** The per-load nonce the CSP was built with; stamped on the <script>. */
  nonce: string;
  /** Webview URI (asWebviewUri(...).toString()) of the esbuild bundle. */
  scriptUri: string;
  /** Document title (inert in a webview tab, but keeps the DOM well-formed). */
  title: string;
  /** Extra <head> markup, e.g. a nonce'd inline <style> block. Trusted. */
  headHtml?: string;
  /** Static body markup rendered before the script. Trusted. */
  bodyHtml?: string;
}

/**
 * The html document shell every scripted webview uses: CSP meta first, then any
 * head extras, then the body chrome, then the single nonce'd bundle <script>.
 * `headHtml`/`bodyHtml` are trusted host-authored markup and embedded verbatim;
 * `title` and `scriptUri` are escaped for their contexts.
 */
export function webviewShellHtml(opts: WebviewShellOptions): string {
  const head = opts.headHtml ? `\n${opts.headHtml}` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(opts.csp)}" />
<title>${escapeHtml(opts.title)}</title>${head}
</head>
<body>
${opts.bodyHtml ?? ""}
  <script nonce="${escapeHtml(opts.nonce)}" src="${escapeHtml(opts.scriptUri)}"></script>
</body>
</html>`;
}

/** Minimal HTML escape for text and double-quoted attribute contexts. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
