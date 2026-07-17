// Elbow wires for the Session Graph tree. After each render (and on resize)
// this measures every `[data-node]` box against its `[data-parent]` container
// and writes one rounded elbow <path> per parent→child pair into the single
// `svg.wires` overlay — graphviz-style edges without a layout engine. Pure DOM,
// no vscode: portable to any surface that renders the same markup.

const ELBOW_RADIUS = 6;
/** Where the wire leaves the parent box: this far in from its left edge. */
const STEM_X = 16;

/** Redraw all connector wires inside `tree` (the `.tree` container). */
export function drawConnectors(tree: HTMLElement): void {
  const svg = tree.querySelector<SVGSVGElement>("svg.wires");
  if (!svg) return;
  const origin = tree.getBoundingClientRect();
  const paths: string[] = [];

  tree.querySelectorAll<HTMLElement>("[data-parent]").forEach((container) => {
    const parentId = container.dataset.parent!;
    const parent = tree.querySelector<HTMLElement>(`[data-node="${cssEscape(parentId)}"]`);
    if (!parent) return;
    const p = parent.getBoundingClientRect();
    const stemX = p.left - origin.left + STEM_X;
    const stemTop = p.bottom - origin.top;

    container.querySelectorAll<HTMLElement>(":scope > [data-node]").forEach((child) => {
      const c = child.getBoundingClientRect();
      const childX = c.left - origin.left;
      const childY = c.top - origin.top + c.height / 2;
      if (childY <= stemTop || childX <= stemX) return; // degenerate layout — skip
      const r = Math.min(ELBOW_RADIUS, childX - stemX, childY - stemTop);
      // Down from under the parent, then a rounded elbow right into the child.
      const d =
        `M ${stemX} ${stemTop}` +
        ` V ${childY - r}` +
        ` Q ${stemX} ${childY} ${stemX + r} ${childY}` +
        ` H ${childX}`;
      const state = child.dataset.state === "running" ? ` data-state="running"` : "";
      paths.push(`<path d="${d}"${state} />`);
    });
  });

  svg.innerHTML = paths.join("");
}

// CSS.escape with a fallback for engines that lack it (the identifiers we emit
// are ids/agent types — worst case the wire is skipped, never a crash).
function cssEscape(s: string): string {
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS;
  if (css?.escape) return css.escape(s);
  return s.replace(/["\\\]]/g, "\\$&");
}
