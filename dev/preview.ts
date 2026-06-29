// Webview preview: render the extension's HTML surfaces with sample data to
// static files and open them in a browser — instant UI iteration, no editor.
//
//   npm run preview            # render + open in the browser
//   PREVIEW_NO_OPEN=1 ...       # render only (CI / scripted)
//
// Run via vite-node so the `vscode` import resolves to the test stub.

import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { landingHtml } from "../src/landing";
import { renderBreakdownHtml } from "../src/panel";
import { buildFeedHtml, parseLine } from "../src/eventsFeed";
import { signalsSummary } from "../src/statusBar";
import { demoScene } from "../src/visualizer/demo";
import { SCENE_CSS, SCENE_BODY } from "../src/visualizer/chrome";
import { sampleTelemetryLines, sampleEvents, heavySummary, cleanSummary } from "./fixtures";

// VS Code webview theme variables (dark-ish) so server-rendered HTML that styles
// itself with var(--vscode-*) looks right in a plain browser.
const THEME = `:root{
  --vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --vscode-editor-font-family:"SF Mono",Menlo,Consolas,monospace;
  --vscode-editor-foreground:#cccccc;--vscode-editor-background:#1e1e1e;
  --vscode-descriptionForeground:#8b8b8b;--vscode-panel-border:#333;
  --vscode-badge-background:#4d4d4d;--vscode-badge-foreground:#fff;
  --vscode-textLink-foreground:#4daafc;--vscode-textBlockQuote-background:#262626;
  --vscode-textCodeBlock-background:#262626;
}
html,body{background:var(--vscode-editor-background);}`;

// Inject THEME into a full HTML document, or wrap a body fragment in a shell.
function themed(html: string, fullDoc: boolean): string {
  if (fullDoc) {
    return html.replace("<head>", `<head><style>${THEME}</style>`);
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${THEME}
  body{font-family:var(--vscode-font-family);color:var(--vscode-editor-foreground);padding:1rem 1.25rem;}
  code{font-family:var(--vscode-editor-font-family)}</style></head><body>${html}</body></html>`;
}

const outDir = fileURLToPath(new URL("./preview-out/", import.meta.url));
fs.mkdirSync(outDir, { recursive: true });

const events = sampleTelemetryLines
  .map(parseLine)
  .filter((e): e is NonNullable<typeof e> => e !== null);

// Cost breakdown panel in its main states: a heavy session (every tip + edge
// case fires), a lean clean session, the zero-state landing, and an unpriced
// (tokens-but-no-rate) session.
const unpricedSummary = {
  ...cleanSummary,
  source: "estimate",
  totals: { input: 6000, output: 1200, cache_read: 0, cache_write: 0, cost_total: 0, currency: "USD" },
  by_model: [
    { model: "composer-x", model_priced: false, tokens: { input: 6000, output: 1200, cache_read: 0, cache_write: 0 }, cost_total: 0 },
  ],
  signals: undefined,
};

const pages: Record<string, string> = {
  "breakdown-heavy.html": themed(renderBreakdownHtml(heavySummary, sampleEvents[2], sampleEvents), true),
  "breakdown-clean.html": themed(renderBreakdownHtml(cleanSummary, sampleEvents[2], sampleEvents.slice(2)), true),
  "breakdown-unpriced.html": themed(renderBreakdownHtml(unpricedSummary, undefined, []), true),
  "breakdown-zero.html": themed(renderBreakdownHtml(undefined, undefined, []), true),
  "telemetry.html": themed(buildFeedHtml(events), true),
  "telemetry-empty.html": themed(buildFeedHtml([]), true),
  "landing.html": themed(landingHtml(), false),
  "tooltip.html": themed(
    `<h3>Status-bar tooltip headline <code>signalsSummary()</code></h3>
     <p><strong>Heavy session:</strong> ${signalsSummary(heavySummary) || "—"}</p>
     <p><strong>Clean session:</strong> ${signalsSummary(cleanSummary) || "—"}</p>
     <p><strong>No signals:</strong> ${signalsSummary({ ...cleanSummary, signals: undefined }) || "<em>(empty — no headline)</em>"}</p>`,
    false,
  ),
};

// The 3D Orchestration Theater, loaded straight from the built esbuild bundle.
// A tiny shim stands in for the VS Code webview API: when the bundle signals
// "ready", we feed it the baked demo scene as a host "load" message.
pages["visualizer.html"] = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />
<style>${THEME}${SCENE_CSS}</style></head>
<body>
${SCENE_BODY}
<script>
  const LOAD = { type: "load", scene: ${JSON.stringify(demoScene())}, mode: "playback", reducedMotion: false, isDemo: true };
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (msg) {
        if (msg && msg.type === "ready") {
          window.dispatchEvent(new MessageEvent("message", { data: LOAD }));
        }
      },
      getState() {}, setState() {},
    };
  };
</script>
<script src="../../media/visualizer.js"></script>
</body></html>`;

const links = Object.keys(pages)
  .map((f) => `<li><a href="./${f}">${f.replace(".html", "")}</a></li>`)
  .join("");
pages["index.html"] = themed(
  `<h2>PromptConduit — webview preview</h2>
   <p class="muted">Sample-data renders of the extension's UI surfaces. Edit a builder, re-run <code>npm run preview</code>.</p>
   <ul>${links}</ul>`,
  false,
);

for (const [file, html] of Object.entries(pages)) {
  fs.writeFileSync(outDir + file, html);
}

const index = outDir + "index.html";
console.log(`Rendered ${Object.keys(pages).length} pages → ${outDir}`);
if (!process.env.PREVIEW_NO_OPEN) {
  try {
    execFileSync("open", [index]);
  } catch {
    console.log(`Open it: ${index}`);
  }
}
