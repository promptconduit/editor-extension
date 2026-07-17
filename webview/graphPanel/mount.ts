// Framework-free mount for the Session Graph. This is the PORTABLE entry point:
// it has zero vscode / editor coupling — just DOM — so any surface can render
// the live tree by feeding it GraphPanelState objects. The VS Code webview
// (main.ts) is one thin adapter over this; a plain website is another:
//
//   import { mountSessionGraph } from "./mount";
//   const graph = mountSessionGraph(document.getElementById("app"));
//   graph.update(stateFromMyApi);              // call again on every poll/push
//   // graph.onPickSession = (key) => { ... }  // wire the session picker
//   // graph.dispose();                        // remove listeners when done
//
// Include GRAPH_PANEL_CSS (src/graphPanel/styles.ts) once on the page; every
// color falls back to a literal when the --vscode-* variables are absent, so
// it themes correctly outside the editor too.
//
// Node selection (click a node → detail panel) and the resizable split between
// the graph and the detail panel are both owned here: pure UI over the current
// state, surviving live updates. The split width is persisted as a percentage
// of the viewport, so it's remembered across reloads and scales across screens.

import type { GraphPanelState } from "../../src/graphPanel/protocol";
import { renderGraphBody } from "./render";
import { drawConnectors } from "./connectors";

export interface SessionGraphHandle {
  /** Re-render with a new state (preserves scroll, selection, split, wires). */
  update(state: GraphPanelState): void;
  /** Called when the user chooses a different session in the picker. */
  onPickSession?: (key: string) => void;
  /** Called when the user clicks the Refresh button (optional on the web). */
  onRefresh?: () => void;
  /** Remove listeners; safe to call once. */
  dispose(): void;
}

// Split-width bounds, as a percentage of the viewport width.
const MIN_PCT = 16;
const MAX_PCT = 60;
const DEFAULT_PCT = 30;
const STORAGE_KEY = "promptconduit.graph.detailPct";
// Below this the layout stacks (matches the CSS breakpoint), so the split is off.
const STACK_BELOW_PX = 992; // 62rem

function loadPct(): number {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    const v = raw ? parseFloat(raw) : NaN;
    if (Number.isFinite(v)) return clampPct(v);
  } catch {
    /* storage unavailable — use the default */
  }
  return DEFAULT_PCT;
}

function savePct(pct: number): void {
  try {
    window.localStorage?.setItem(STORAGE_KEY, String(Math.round(pct * 10) / 10));
  } catch {
    /* best-effort */
  }
}

function clampPct(pct: number): number {
  return Math.min(MAX_PCT, Math.max(MIN_PCT, pct));
}

/** Mount an interactive Session Graph into `container`. Pure DOM, no vscode. */
export function mountSessionGraph(container: HTMLElement): SessionGraphHandle {
  let lastState: GraphPanelState | undefined;
  let selectedId: string | undefined;
  let detailPct = loadPct();
  let dragging = false;
  let rafId = 0;

  // Apply the persisted split width to the detail column (in vw so it stays a
  // fraction of the screen). The stacked-layout CSS uses !important, so this is
  // a no-op below the breakpoint — the panel goes full-width there.
  const applyWidth = () => {
    const detail = container.querySelector<HTMLElement>(".detail-col");
    if (!detail) return;
    detail.style.flex = `0 0 ${detailPct}vw`;
    detail.style.width = `${detailPct}vw`;
  };

  const redraw = () => {
    const tree = container.querySelector<HTMLElement>("#tree");
    if (tree) drawConnectors(tree);
  };

  const rerender = () => {
    if (!lastState) return;
    const scroller = document.scrollingElement ?? document.documentElement;
    const scrollTop = scroller.scrollTop;
    container.innerHTML = renderGraphBody(lastState, Date.now(), selectedId);
    scroller.scrollTop = scrollTop;
    applyWidth();
    redraw();
  };

  const handle: SessionGraphHandle = {
    update(state: GraphPanelState): void {
      lastState = state;
      // A live push mid-drag would rebuild the DOM under the pointer; hold it
      // and repaint when the drag ends.
      if (!dragging) rerender();
    },
    dispose(): void {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onDragMove);
      window.removeEventListener("pointerup", onDragEnd);
      container.removeEventListener("change", onChange);
      container.removeEventListener("click", onClick);
      container.removeEventListener("pointerdown", onPointerDown);
    },
  };

  const onResize = () => {
    applyWidth();
    redraw();
  };

  const onChange = (e: Event) => {
    const picker = (e.target as HTMLElement).closest<HTMLSelectElement>("select[data-picker]");
    if (picker) handle.onPickSession?.(picker.value);
  };

  const onClick = (e: Event) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLButtonElement>("button[data-cmd]");
    if (btn?.dataset.cmd === "refresh") {
      handle.onRefresh?.();
      return;
    }
    // A node click selects it (or toggles it off) and opens the detail panel.
    const node = target.closest<HTMLElement>("[data-node]");
    if (node) {
      const id = node.dataset.node;
      selectedId = selectedId === id ? undefined : id;
      rerender();
    }
  };

  // ---- resizable split ----

  const onPointerDown = (e: PointerEvent) => {
    const divider = (e.target as HTMLElement).closest<HTMLElement>("[data-divider]");
    if (!divider || window.innerWidth < STACK_BELOW_PX) return;
    dragging = true;
    document.body.classList.add("pc-graph-resizing");
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
    e.preventDefault();
  };

  const onDragMove = (e: PointerEvent) => {
    if (!dragging) return;
    // Detail column hugs the right edge, so its width is the distance from the
    // pointer to the viewport's right edge.
    const pct = ((window.innerWidth - e.clientX) / window.innerWidth) * 100;
    detailPct = clampPct(pct);
    // Coalesce to one width application per frame while dragging.
    if (!rafId) {
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        applyWidth();
        redraw();
      });
    }
  };

  const onDragEnd = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("pc-graph-resizing");
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    if (rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
    }
    savePct(detailPct);
    // Repaint to pick up any state that arrived while we were holding it back.
    rerender();
  };

  window.addEventListener("resize", onResize);
  container.addEventListener("change", onChange);
  container.addEventListener("click", onClick);
  container.addEventListener("pointerdown", onPointerDown);

  return handle;
}
