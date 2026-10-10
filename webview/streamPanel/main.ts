// Stream webview client. Receives full StreamPanelState pushes from the host
// and re-renders the whole body (the table is small — MAX_EVENTS rows — so a
// full swap is cheap). Expansion state lives here (userOpen/userClosed sets
// keyed by data-exp = eventId) and the scroll position is saved/restored
// around the innerHTML swap, so pushes never collapse what the user opened or
// yank the viewport.
//
// State pushes omit each row's rawJson (it can total megabytes); rows carry
// rawAvailable instead, and the raw JSON is requested when a row is expanded
// and cached here for as long as the row is in the feed.

import type { StreamPanelState, HostMessage, WebviewMessage } from "../../src/streamPanel/protocol";
import { renderStreamBody } from "./render";

declare function acquireVsCodeApi(): { postMessage(msg: WebviewMessage): void };

const vscode = acquireVsCodeApi();

// ---- expansion state ----
// Rows default to closed; userOpen/userClosed record explicit user choices and
// win over defaults across re-renders.
const userOpen = new Set<string>();
const userClosed = new Set<string>();

function applyExpansion(root: ParentNode): void {
  root.querySelectorAll<HTMLDetailsElement>("details[data-exp]").forEach((d) => {
    const id = d.dataset.exp!;
    if (userOpen.has(id)) {
      d.open = true;
    } else if (userClosed.has(id)) {
      d.open = false;
    }
  });
}

// ---- raw JSON on demand ----

const rawCache = new Map<string, string>();
const rawRequested = new Set<string>();

function requestRaw(ids: string[]): void {
  const want = ids.filter((id) => !rawCache.has(id) && !rawRequested.has(id) && rawAvailable.has(id));
  if (want.length === 0) {
    return;
  }
  for (const id of want) rawRequested.add(id);
  vscode.postMessage({ type: "raw_request", ids: want });
}

// ---- render ----

const app = document.getElementById("app") ?? document.body;
let lastState: StreamPanelState | undefined;
// eventIds in lastState whose raw JSON the host can supply.
let rawAvailable = new Set<string>();

function renderState(state: StreamPanelState): void {
  lastState = state;
  rawAvailable = new Set(state.events.filter((e) => e.rawAvailable).map((e) => e.eventId));
  // Forget raw JSON for rows that left the feed.
  const live = new Set(state.events.map((e) => e.eventId));
  for (const id of rawCache.keys()) {
    if (!live.has(id)) rawCache.delete(id);
  }
  for (const id of rawRequested) {
    if (!rawAvailable.has(id)) rawRequested.delete(id);
  }
  const merged: StreamPanelState = {
    ...state,
    events: state.events.map((e) => {
      const raw = e.rawJson === undefined ? rawCache.get(e.eventId) : undefined;
      return raw === undefined ? e : { ...e, rawJson: raw };
    }),
  };
  // Preserve the viewport across the wholesale swap.
  const scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
  app.innerHTML = renderStreamBody(merged);
  applyExpansion(app);
  document.documentElement.scrollTop = document.body.scrollTop = scrollTop;
  requestRaw(
    Array.from(app.querySelectorAll<HTMLDetailsElement>("details[data-exp]"))
      .filter((d) => d.open)
      .map((d) => d.dataset.exp!),
  );
}

// ---- interactions (event delegation) ----

document.addEventListener(
  "toggle",
  (e) => {
    const d = e.target as HTMLDetailsElement;
    const id = d?.dataset?.exp;
    if (!id) {
      return;
    }
    if (d.open) {
      userOpen.add(id);
      userClosed.delete(id);
      requestRaw([id]);
    } else {
      userClosed.add(id);
      userOpen.delete(id);
    }
  },
  true,
);

function setAll(open: boolean): void {
  const ids: string[] = [];
  document.querySelectorAll<HTMLDetailsElement>("details[data-exp]").forEach((d) => {
    ids.push(d.dataset.exp!);
    const id = d.dataset.exp!;
    d.open = open;
    if (open) {
      userOpen.add(id);
      userClosed.delete(id);
    } else {
      userClosed.add(id);
      userOpen.delete(id);
    }
  });
  if (open) {
    requestRaw(ids);
  }
}

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;

  // Session badge in the unified feed: drill into just that session. The badge
  // lives inside a <summary>, so cancel the default click (which would toggle
  // the row's <details>) before posting.
  const badge = target.closest<HTMLButtonElement>("button[data-drill]");
  if (badge) {
    e.preventDefault();
    vscode.postMessage({ type: "drill", key: badge.dataset.drill! });
    return;
  }

  const btn = target.closest<HTMLButtonElement>("button[data-cmd]");
  if (btn) {
    const cmd = btn.dataset.cmd!;
    if (cmd === "expandAll") {
      setAll(true);
    } else if (cmd === "collapseAll") {
      setAll(false);
    } else if (cmd === "drillIn" || cmd === "showAll" || cmd === "refresh") {
      vscode.postMessage({ type: "command", id: cmd });
    }
    return;
  }

  // Copy buttons copy their preceding sibling's text (the session-key <code>
  // or the raw-JSON <pre>); data-copy-label restores the idle label.
  const copy = target.closest<HTMLButtonElement>("button.copy");
  if (copy) {
    const src = copy.previousElementSibling as HTMLElement | null;
    const text = src?.textContent ?? "";
    const label = copy.dataset.copyLabel ?? "Copy";
    void navigator.clipboard.writeText(text).then(() => {
      copy.classList.add("done");
      copy.textContent = "Copied";
      setTimeout(() => {
        copy.classList.remove("done");
        copy.textContent = label;
      }, 1200);
    });
    return;
  }

  const anchor = target.closest<HTMLAnchorElement>("a[href]");
  if (anchor) {
    e.preventDefault();
    vscode.postMessage({ type: "open_external", url: anchor.getAttribute("href") ?? "" });
  }
});

window.addEventListener("message", (e: MessageEvent<HostMessage>) => {
  const msg = e.data;
  if (msg?.type === "state") {
    renderState(msg.state);
  } else if (msg?.type === "raw") {
    for (const it of msg.items) {
      rawCache.set(it.eventId, it.rawJson);
      rawRequested.delete(it.eventId);
    }
    if (lastState) {
      renderState(lastState);
    }
  }
});

vscode.postMessage({ type: "ready" });
