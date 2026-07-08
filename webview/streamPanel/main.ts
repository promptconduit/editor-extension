// Stream webview client. Receives full StreamPanelState pushes from the host
// and re-renders the whole body (the table is small — MAX_EVENTS rows — so a
// full swap is cheap). Expansion state lives here (userOpen/userClosed sets
// keyed by data-exp = eventId) and the scroll position is saved/restored
// around the innerHTML swap, so pushes never collapse what the user opened or
// yank the viewport.

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

// ---- render ----

const app = document.getElementById("app") ?? document.body;

function renderState(state: StreamPanelState): void {
  // Preserve the viewport across the wholesale swap.
  const scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
  app.innerHTML = renderStreamBody(state);
  applyExpansion(app);
  document.documentElement.scrollTop = document.body.scrollTop = scrollTop;
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
    } else {
      userClosed.add(id);
      userOpen.delete(id);
    }
  },
  true,
);

function setAll(open: boolean): void {
  document.querySelectorAll<HTMLDetailsElement>("details[data-exp]").forEach((d) => {
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
}

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;

  const btn = target.closest<HTMLButtonElement>("button[data-cmd]");
  if (btn) {
    const cmd = btn.dataset.cmd!;
    if (cmd === "expandAll") {
      setAll(true);
    } else if (cmd === "collapseAll") {
      setAll(false);
    } else if (cmd === "pinSession" || cmd === "followActive") {
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
  }
});

vscode.postMessage({ type: "ready" });
