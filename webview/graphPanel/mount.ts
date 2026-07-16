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
// Node selection (click a node → detail panel) is owned here: it's pure UI over
// the current state, so it survives live state updates and needs no server
// round-trip.

import type { GraphPanelState } from "../../src/graphPanel/protocol";
import { renderGraphBody } from "./render";
import { drawConnectors } from "./connectors";

export interface SessionGraphHandle {
  /** Re-render with a new state (preserves scroll, selection, and wires). */
  update(state: GraphPanelState): void;
  /** Called when the user chooses a different session in the picker. */
  onPickSession?: (key: string) => void;
  /** Called when the user clicks the Refresh button (optional on the web). */
  onRefresh?: () => void;
  /** Remove listeners; safe to call once. */
  dispose(): void;
}

/** Mount an interactive Session Graph into `container`. Pure DOM, no vscode. */
export function mountSessionGraph(container: HTMLElement): SessionGraphHandle {
  let lastState: GraphPanelState | undefined;
  let selectedId: string | undefined;

  const rerender = () => {
    if (!lastState) return;
    const scroller = document.scrollingElement ?? document.documentElement;
    const scrollTop = scroller.scrollTop;
    container.innerHTML = renderGraphBody(lastState, Date.now(), selectedId);
    scroller.scrollTop = scrollTop;
    const tree = container.querySelector<HTMLElement>("#tree");
    if (tree) drawConnectors(tree);
  };

  const handle: SessionGraphHandle = {
    update(state: GraphPanelState): void {
      lastState = state;
      rerender();
    },
    dispose(): void {
      window.removeEventListener("resize", redraw);
      container.removeEventListener("change", onChange);
      container.removeEventListener("click", onClick);
    },
  };

  const redraw = () => {
    const tree = container.querySelector<HTMLElement>("#tree");
    if (tree) drawConnectors(tree);
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

  // Wires depend on box positions, so any reflow moves them.
  window.addEventListener("resize", redraw);
  container.addEventListener("change", onChange);
  container.addEventListener("click", onClick);

  return handle;
}
