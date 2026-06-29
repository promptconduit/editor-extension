// The hover card: a DOM overlay (crisp, unaffected by bloom) showing a node's
// label, repo/branch, and linked GitHub issue/PR. Links route through the host
// (open_external) because the CSP forbids navigation inside the frame.
import type { GraphNode, GitHubRef } from "../src/visualizer/types";

export class HoverCard {
  private el: HTMLElement;
  private current: string | undefined;

  constructor(private readonly openExternal: (url: string) => void) {
    this.el = document.getElementById("hover")!;
  }

  show(node: GraphNode, x: number, y: number): void {
    if (this.current !== node.id) {
      this.render(node);
      this.current = node.id;
    }
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y - 14}px`;
    this.el.classList.remove("hidden");
  }

  hide(): void {
    this.el.classList.add("hidden");
    this.current = undefined;
  }

  private render(node: GraphNode): void {
    this.el.replaceChildren();

    const title = div("h-title", node.label);
    this.el.appendChild(title);

    const subParts: string[] = [];
    if (node.repo) subParts.push(node.repo);
    if (node.branch) subParts.push(node.branch);
    if (node.kind === "subagent") subParts.unshift("sub-agent");
    if (subParts.length) this.el.appendChild(div("h-sub", subParts.join(" · ")));

    const refs = node.github?.refs ?? [];
    if (refs.length) {
      for (const r of refs) this.el.appendChild(this.refLink(r));
    } else if (node.github?.repoUrl) {
      this.el.appendChild(this.link(node.github.repoUrl, "Open repository ↗", "repo"));
    }
  }

  private refLink(r: GitHubRef): HTMLElement {
    const tag = r.kind === "pr" ? "PR" : "issue";
    const state = r.state ? ` (${r.state})` : "";
    const label = r.title ? `#${r.number} ${r.title}${state}` : `#${r.number}${state}`;
    const url = r.url || "";
    return this.link(url, label, tag);
  }

  private link(url: string, label: string, tag: string): HTMLElement {
    const a = document.createElement("a");
    const t = document.createElement("span");
    t.className = "tag";
    t.textContent = tag;
    a.appendChild(t);
    a.appendChild(document.createTextNode(label));
    if (url) {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        this.openExternal(url);
      });
    }
    return a;
  }
}

function div(cls: string, text: string): HTMLElement {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  return d;
}
