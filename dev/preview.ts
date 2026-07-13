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
import { ConversationStore } from "../src/state";
import { parseEnvelopeV2, costEventsFrom } from "../src/envelope";
import { buildCostPanelState } from "../src/costPanel/viewModel";
import { COST_PANEL_CSS } from "../src/costPanel/styles";
import type { CostPanelState } from "../src/costPanel/protocol";
import { buildStreamPanelState, parseStreamLine, StreamState } from "../src/streamFeed";
import { STREAM_PANEL_CSS } from "../src/streamPanel/styles";
import type { StreamPanelState } from "../src/streamPanel/protocol";
import { signalsSummary } from "../src/statusBar";
import { parseEnvelopeLine, reduceToSnapshot, reduceToTrends } from "../src/coaching/derive";
import { buildCoachingInsights } from "../src/coaching/insights";
import { renderCoachingHtml } from "../src/coaching/render";
import { demoScene } from "../src/visualizer/demo";
import { SCENE_CSS, SCENE_BODY } from "../src/visualizer/chrome";
import {
  sampleCoachingLines,
  sampleStreamLines,
  samplePromptStoryLines,
  sampleEnrichmentLines,
  heavySummary,
  cleanSummary,
} from "./fixtures";

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

// Stream panel: run the sample lines through the REAL pipeline (parseStreamLine
// → StreamState → buildStreamPanelState) and load the actual esbuild webview
// bundle with the same vscode-api shim as the cost panel — expansion, raw JSON
// highlighting, and copy all work.
function streamPanelStateFromFixtures(drillKey?: string): StreamPanelState {
  const s = new StreamState();
  for (const line of sampleStreamLines) {
    const ev = parseStreamLine(line);
    if (ev) s.record(ev);
  }
  if (drillKey) s.drillIn(drillKey);
  return buildStreamPanelState(s, 1, false);
}

function streamPanelPage(state: StreamPanelState): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />
<style>${THEME}${STREAM_PANEL_CSS}</style></head>
<body>
<div id="app"></div>
<script>
  const STATE = { type: "state", state: ${JSON.stringify(state)} };
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (msg) {
        if (msg && msg.type === "ready") {
          window.dispatchEvent(new MessageEvent("message", { data: STATE }));
        }
        if (msg && msg.type === "open_external" && msg.url) {
          window.open(msg.url, "_blank");
        }
      },
      getState() {}, setState() {},
    };
  };
</script>
<script src="../../media/streamPanel.js"></script>
</body></html>`;
}

// Cost Breakdown detail report: run the story fixture through the REAL
// pipeline (ConversationStore -> buildCostPanelState) and load the actual
// esbuild webview bundle with a tiny vscode-api shim, exactly like the
// visualizer preview — expansion, tooltips, geometry, and copy all work.
function storeFromLines(lines: string[]): ConversationStore {
  const store = new ConversationStore();
  for (const line of lines) {
    const env = parseEnvelopeV2(line);
    if (!env) continue;
    store.recordEnvelope(env);
    for (const ev of costEventsFrom(env)) {
      store.recordEvent(ev);
    }
  }
  return store;
}

function costPanelPage(state: CostPanelState): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />
<style>${THEME}${COST_PANEL_CSS}</style></head>
<body>
<div id="app"></div>
<script>
  const STATE = { type: "state", state: ${JSON.stringify(state)} };
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (msg) {
        if (msg && msg.type === "ready") {
          window.dispatchEvent(new MessageEvent("message", { data: STATE }));
        }
        if (msg && msg.type === "open_external" && msg.url) {
          window.open(msg.url, "_blank");
        }
      },
      getState() {}, setState() {},
    };
  };
</script>
<script src="../../media/costPanel.js"></script>
</body></html>`;
}

const storyStore = storeFromLines(samplePromptStoryLines);
const multiStore = storeFromLines([...samplePromptStoryLines, ...sampleEnrichmentLines]);

// Coaching tab: derive the report from the rich sample envelopes, exactly as the
// live tab does from events.jsonl.
const coachingEvents = sampleCoachingLines
  .map(parseEnvelopeLine)
  .filter((e): e is NonNullable<typeof e> => e !== null);
const coachingSnapshot = reduceToSnapshot(coachingEvents);
if (coachingSnapshot) {
  coachingSnapshot.insights = buildCoachingInsights(coachingSnapshot.metrics);
}
const coachingTrends = reduceToTrends(coachingEvents, 0);

const pages: Record<string, string> = {
  "breakdown-detail.html": costPanelPage(buildCostPanelState(storyStore, "session")),
  "breakdown-all.html": costPanelPage(buildCostPanelState(multiStore, "all")),
  "breakdown-zero.html": costPanelPage(buildCostPanelState(new ConversationStore(), "session")),
  "coaching-rich.html": themed(renderCoachingHtml(coachingSnapshot, coachingTrends), true),
  "coaching-empty.html": themed(renderCoachingHtml(undefined), true),
  "stream.html": streamPanelPage(streamPanelStateFromFixtures()),
  "stream-drilled.html": streamPanelPage(streamPanelStateFromFixtures("cc-1")),
  "stream-empty.html": streamPanelPage(buildStreamPanelState(new StreamState(), 1, false)),
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
