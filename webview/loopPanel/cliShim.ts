// Browser host for The Loop when served by the CLI (`promptconduit loop`).
// The editor talks to the webview over postMessage; here the same webview
// client (main.ts) talks to this shim instead. It polls the CLI's local
// /api/events endpoint for raw envelope lines, runs them through the same
// ConversationStore + view model the extension uses, and answers the
// client's messages. Imported before main.ts so acquireVsCodeApi exists when
// main.ts initialises.

import { costEventsFrom, parseEnvelopeV2 } from "../../src/envelope";
import { ConversationStore } from "../../src/state";
import { buildLoopPanelState, type LoopSelection } from "../../src/loopPanel/viewModel";
import type { WebviewMessage } from "../../src/loopPanel/protocol";
import { LOOP_PANEL_CSS } from "../../src/loopPanel/styles";

interface EventsResponse {
  lines: string[];
  cursor: number;
  more: boolean;
}

// No editor theme here: the stylesheet's literal fallbacks are dark, so a
// light-mode browser gets the light overrides via the same body class.
const style = document.createElement("style");
style.textContent = LOOP_PANEL_CSS;
document.head.appendChild(style);
if (window.matchMedia("(prefers-color-scheme: light)").matches) {
  document.body.classList.add("vscode-light");
  document.documentElement.style.setProperty("--vscode-editor-background", "#ffffff");
  document.documentElement.style.setProperty("--vscode-editorWidget-background", "#f4f6f6");
  document.documentElement.style.setProperty("--vscode-foreground", "#1f2a2c");
  document.documentElement.style.setProperty("--vscode-descriptionForeground", "#5d6f72");
  document.documentElement.style.setProperty("--vscode-widget-border", "#d6dfe0");
  document.documentElement.style.setProperty("--vscode-badge-background", "#e7eeee");
  document.documentElement.style.setProperty("--vscode-badge-foreground", "#1f2a2c");
}
if (!document.getElementById("app")) {
  const app = document.createElement("div");
  app.id = "app";
  document.body.appendChild(app);
}

const POLL_MS = 1500;
const BATCH_LIMIT = 5000;

const store = new ConversationStore();
let selection: LoopSelection = { followLatest: true };
let ready = false;
let cursor = 0;
let pulling = false;
let shownKey: string | undefined;

function push(): void {
  if (!ready) return;
  const key = store.displayKey;
  if (key !== shownKey) {
    shownKey = key;
    selection = { followLatest: true };
  }
  const state = buildLoopPanelState(store, selection);
  window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } }));
}

function onMessage(msg: WebviewMessage): void {
  switch (msg.type) {
    case "ready":
      ready = true;
      push();
      break;
    case "selectPrompt":
      selection = { followLatest: false, promptId: msg.promptId };
      push();
      break;
    case "open_external":
      if (/^https?:\/\//i.test(msg.url)) window.open(msg.url, "_blank", "noopener");
      break;
    case "command":
      if (msg.id === "followLatest") {
        selection = { followLatest: true };
        push();
      } else if (msg.id === "refresh") {
        window.location.reload();
      }
      break;
    case "log":
      console[msg.level === "error" ? "error" : "log"](`[loop] ${msg.msg}`);
      break;
  }
}

(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage: (m: WebviewMessage) => queueMicrotask(() => onMessage(m)),
});

// Drain everything newer than `cursor`; repaint after each batch so a large
// backfill fills in progressively. Guarded so overlapping ticks can't double-fetch.
async function pull(): Promise<void> {
  if (pulling) return;
  pulling = true;
  try {
    for (;;) {
      const res = await fetch(`/api/events?after=${cursor}&limit=${BATCH_LIMIT}`);
      if (!res.ok) break;
      const body = (await res.json()) as EventsResponse;
      for (const line of body.lines) {
        const env = parseEnvelopeV2(line);
        if (!env) continue;
        store.recordEnvelope(env);
        for (const ev of costEventsFrom(env)) store.recordEvent(ev);
      }
      cursor = body.cursor;
      push();
      if (!body.more) break;
    }
  } catch {
    // Server gone or a transient error: keep the last view, retry next tick.
  } finally {
    pulling = false;
  }
}

void pull();
setInterval(() => void pull(), POLL_MS);
