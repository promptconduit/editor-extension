// Cost Breakdown webview client. Receives full CostPanelState pushes from the
// host and renders in three zones: `top` and `rest` swap wholesale (cheap),
// the ledger diffs per prompt group by id+rev so an expanded raw-JSON block is
// not rebuilt on every event. Expansion state lives here (open/closed sets
// keyed by data-exp), so pushes never collapse what the user opened.

import type { CostPanelState, HostMessage, WebviewMessage } from "../../src/costPanel/protocol";
import { renderZones } from "./render";

declare function acquireVsCodeApi(): { postMessage(msg: WebviewMessage): void };

const vscode = acquireVsCodeApi();

// ---- expansion state ----
// Defaults come from the rendered HTML (`open` attributes); userOpen/userClosed
// record explicit user choices and win over defaults across re-renders.
const userOpen = new Set<string>();
const userClosed = new Set<string>();

// querySelectorAll only returns DESCENDANTS — when the root itself is a
// rebuilt <details data-exp> ledger entry, its own expansion must be restored
// explicitly or a live-updating entry the user opened would snap shut.
function applyExpansion(root: ParentNode): void {
  const apply = (d: HTMLDetailsElement) => {
    const id = d.dataset.exp!;
    if (userOpen.has(id)) {
      d.open = true;
    } else if (userClosed.has(id)) {
      d.open = false;
    }
  };
  if (root instanceof HTMLElement && root.matches("details[data-exp]")) {
    apply(root as HTMLDetailsElement);
  }
  root.querySelectorAll<HTMLDetailsElement>("details[data-exp]").forEach(apply);
}

// CSP blocks style="" attributes; geometry arrives as data-* and is applied
// through CSSOM, which the CSP allows.
function applyGeometry(root: ParentNode): void {
  const apply = (el: HTMLElement) => {
    el.style.width = `${el.dataset.w}%`;
    if (el.dataset.left !== undefined) {
      el.style.left = `${el.dataset.left}%`;
    }
  };
  if (root instanceof HTMLElement && root.matches("[data-w]")) {
    apply(root);
  }
  root.querySelectorAll<HTMLElement>("[data-w]").forEach(apply);
}

function hydrate(root: ParentNode): void {
  applyExpansion(root);
  applyGeometry(root);
}

// ---- zones ----

const app = document.getElementById("app") ?? document.body;
let zoneTop: HTMLElement | undefined;
let zoneLedger: HTMLElement | undefined;
let zoneRest: HTMLElement | undefined;

function ensureZones(): { top: HTMLElement; ledger: HTMLElement; rest: HTMLElement } {
  if (!zoneTop || !zoneLedger || !zoneRest) {
    app.innerHTML = `<div id="pc-top"></div><div id="pc-ledger"></div><div id="pc-rest"></div>`;
    zoneTop = document.getElementById("pc-top")!;
    zoneLedger = document.getElementById("pc-ledger")!;
    zoneRest = document.getElementById("pc-rest")!;
  }
  return { top: zoneTop, ledger: zoneLedger, rest: zoneRest };
}

interface LedgerCacheEntry {
  rev: number;
  el: HTMLElement;
}
let ledgerCache = new Map<string, LedgerCacheEntry>();
let lastMode: string | undefined;

function htmlToElement(html: string): HTMLElement {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild as HTMLElement;
}

function renderState(state: CostPanelState): void {
  const z = ensureZones();
  const zones = renderZones(state);

  if (state.mode !== lastMode) {
    // Mode flip: rebuild everything, drop the diff cache.
    ledgerCache = new Map();
    lastMode = state.mode;
    z.ledger.innerHTML = "";
  }

  z.top.innerHTML = zones.top;
  hydrate(z.top);
  z.rest.innerHTML = zones.rest;
  hydrate(z.rest);

  if (!zones.ledger) {
    z.ledger.innerHTML = "";
    ledgerCache = new Map();
    return;
  }

  // Ledger diff: reuse untouched groups, replace changed ones, keep order.
  let section = z.ledger.querySelector<HTMLElement>("section.ledger");
  if (!section) {
    z.ledger.innerHTML = `<section class="ledger">${zones.ledger.header}<div class="ledger-items"></div><div class="ledger-footer"></div></section>`;
    section = z.ledger.querySelector<HTMLElement>("section.ledger")!;
  }
  const itemsHost = section.querySelector<HTMLElement>(".ledger-items")!;

  const next = new Map<string, LedgerCacheEntry>();
  const orderedEls: HTMLElement[] = [];
  for (const item of zones.ledger.items) {
    const cached = ledgerCache.get(item.id);
    if (cached && cached.rev === item.rev) {
      next.set(item.id, cached);
      orderedEls.push(cached.el);
      continue;
    }
    const el = htmlToElement(item.html);
    hydrate(el); // restores the entry's own open state plus its sub-sections
    next.set(item.id, { rev: item.rev, el });
    orderedEls.push(el);
  }
  // Prune expansion ids belonging to evicted groups so the sets stay bounded
  // in a long-lived webview (sub-section ids are prefixed with the group id).
  for (const oldId of ledgerCache.keys()) {
    if (!next.has(oldId)) {
      for (const set of [userOpen, userClosed]) {
        for (const id of [...set]) {
          if (id === oldId || id.startsWith(`${oldId}:`)) {
            set.delete(id);
          }
        }
      }
    }
  }
  ledgerCache = next;

  const current = [...itemsHost.children] as HTMLElement[];
  if (current.length !== orderedEls.length || orderedEls.some((el, i) => current[i] !== el)) {
    itemsHost.replaceChildren(...orderedEls);
  }
  section.querySelector<HTMLElement>(".ledger-footer")!.innerHTML = zones.ledger.footer;
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
    } else if (
      cmd === "pinSession" ||
      cmd === "followActive" ||
      cmd === "showAll" ||
      cmd === "showSession"
    ) {
      vscode.postMessage({ type: "command", id: cmd });
    }
    return;
  }

  const copy = target.closest<HTMLButtonElement>("button.copy");
  if (copy) {
    const pre = copy.previousElementSibling as HTMLElement | null;
    const text = pre?.textContent ?? "";
    void navigator.clipboard.writeText(text).then(() => {
      copy.classList.add("done");
      copy.textContent = "Copied";
      setTimeout(() => {
        copy.classList.remove("done");
        copy.textContent = "Copy JSON";
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
