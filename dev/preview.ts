// Webview preview: render The Loop with sample data to static files and open
// them in a browser — instant UI iteration, no editor. The data is a real
// "publish the blog post" prompt (test/fixtures/blogPrompt.ts) plus a handful
// of past ship prompts so every section has something to show.
//
//   npm run preview            # render + open in the browser
//   PREVIEW_NO_OPEN=1 ...       # render only (CI / screenshots)
//
// Run via vite-node so the `vscode` import resolves to the test stub.

import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ConversationStore } from "../src/state";
import { parseEnvelopeV2, costEventsFrom } from "../src/envelope";
import { buildLoopPanelState } from "../src/loopPanel/viewModel";
import { LOOP_PANEL_CSS } from "../src/loopPanel/styles";
import type { LoopPanelState } from "../src/loopPanel/protocol";
import { costEnvelope, v2Envelope } from "./fixtures";
import { S, lines as blogLines, req } from "../test/fixtures/blogPrompt";

// VS Code dark/light theme variables, so the panel looks as it does in the editor.
const DARK = `:root{--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
--vscode-editor-font-family:"SF Mono",Menlo,Consolas,monospace;--vscode-foreground:#cccccc;
--vscode-editor-background:#1e1e1e;--vscode-editorWidget-background:#252526;--vscode-descriptionForeground:#9d9d9d;
--vscode-widget-border:#3c3c3c;--vscode-badge-background:#4d4d4d;--vscode-badge-foreground:#fff;
--vscode-textLink-foreground:#4daafc;--vscode-button-background:#0e7a70;--vscode-button-foreground:#fff}`;
const LIGHT = `:root{--vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
--vscode-editor-font-family:"SF Mono",Menlo,Consolas,monospace;--vscode-foreground:#3b3b3b;
--vscode-editor-background:#ffffff;--vscode-editorWidget-background:#f3f3f3;--vscode-descriptionForeground:#6b6b6b;
--vscode-widget-border:#d4d4d4;--vscode-badge-background:#e4e4e4;--vscode-badge-foreground:#333;
--vscode-textLink-foreground:#0060c0;--vscode-button-background:#0b8f84;--vscode-button-foreground:#fff}`;

/** Past ship prompts in other sessions: [day, roundTrips, context]. */
const PAST: [number, number, number][] = [
  [10, 1, 333_000], [11, 5, 86_000], [12, 2, 177_000], [13, 5, 489_000], [17, 4, 190_000],
  [21, 11, 103_000], [23, 4, 87_000], [29, 6, 124_000], [3, 6, 111_000], [6, 2, 151_000],
];

function pastLines(): string[] {
  const out: string[] = [];
  PAST.forEach(([day, calls, ctx], i) => {
    const month = day > 7 ? "10" : "11";
    const d = String(day).padStart(2, "0");
    const sid = `past-${i}`;
    const pid = `past-p${i}`;
    out.push(
      v2Envelope("claude-code", "UserPromptSubmit", `2026-${month}-${d}T15:00:00Z`, {
        sessionId: sid,
        promptId: pid,
        raw: { prompt: i % 2 ? "merge it" : `merge #${40 + i} when CI is green` },
      }),
    );
    const reqs = Array.from({ length: calls }, (_, j) =>
      req(`${pid}-r${j}`, `2026-${month}-${d}T15:00:${String(10 + j * 4).padStart(2, "0")}.000Z`, [
        2, 250, ctx + j * 400, 300,
      ]),
    );
    out.push(costEnvelope("claude-code", `2026-${month}-${d}T15:02:00Z`, sid, reqs, { promptId: pid }));
  });
  return out;
}

function store(): ConversationStore {
  const s = new ConversationStore();
  for (const l of [...pastLines(), ...blogLines()]) {
    const env = parseEnvelopeV2(l);
    if (!env) continue;
    s.recordEnvelope(env);
    for (const ev of costEventsFrom(env)) s.recordEvent(ev);
  }
  s.setPinnedKey(S);
  return s;
}

function page(state: LoopPanelState, theme: "dark" | "light"): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />
<style>${theme === "dark" ? DARK : LIGHT}${LOOP_PANEL_CSS}</style></head>
<body class="vscode-${theme}">
<div id="app"></div>
<script>
  const STATE = { type: "state", state: ${JSON.stringify(state)} };
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (msg) {
        if (msg && msg.type === "ready") window.dispatchEvent(new MessageEvent("message", { data: STATE }));
        if (msg && msg.type === "open_external" && msg.url) window.open(msg.url, "_blank");
      },
    };
  };
</script>
<script src="../../media/loopPanel.js"></script>
</body></html>`;
}

const outDir = fileURLToPath(new URL("./preview-out/", import.meta.url));
fs.mkdirSync(outDir, { recursive: true });

const blog = buildLoopPanelState(store(), { followLatest: false, promptId: "p-blog" });
const empty = buildLoopPanelState(new ConversationStore(), { followLatest: true }, {
  usd: 412.37,
  sessions: 38,
  windowDays: 30,
});
const files: [string, string][] = [
  ["loop.html", page(blog, "dark")],
  ["loop-light.html", page(blog, "light")],
  ["loop-empty.html", page(empty, "dark")],
];
for (const [name, html] of files) fs.writeFileSync(outDir + name, html);
console.log(`wrote ${files.map(([n]) => n).join(", ")} → ${outDir}`);

if (!process.env.PREVIEW_NO_OPEN) {
  try {
    execFileSync("open", [outDir + "loop.html"]);
  } catch {
    // not macOS — print the path above and open it manually
  }
}
