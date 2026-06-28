// Tiny, dependency-free HTML helpers shared by the cost panel and the zero-state
// landing. Both webviews run with `enableScripts: false`, so everything here is
// plain server-rendered markup — escaping and anchor/list rendering only, no
// behaviour. Centralised so escaping is identical everywhere and the "Learn
// more" link list is built one way from the single link registry (links.ts).

import { ResourceLink, isSafeHttpUrl, learnMoreLinks } from "./links";
import { ToolId } from "./types";

/** Escape the five HTML-significant characters for safe text/attribute interpolation. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A single anchor for `href` with visible text `label`. Falls back to the
 * escaped label as plain text when the href isn't a safe http(s) URL, so an
 * unexpected scheme degrades to text instead of an active link. Both inputs are
 * escaped.
 */
export function anchorHtml(href: string, label: string): string {
  const text = escapeHtml(label);
  return isSafeHttpUrl(href) ? `<a href="${escapeHtml(href)}">${text}</a>` : text;
}

/**
 * Render one external resource as a list item: a link plus its description.
 * Label and description are always escaped; the anchor degrades to text for an
 * unsafe scheme (see {@link anchorHtml}).
 */
export function linkItemHtml(link: ResourceLink): string {
  const desc = link.desc ? `<span class="desc"> — ${escapeHtml(link.desc)}</span>` : "";
  return `<li>${anchorHtml(link.href, link.label)}${desc}</li>`;
}

/**
 * The shared "Learn more" section: a heading plus the tool-ordered resource
 * list. Used by the breakdown panel (with the active tool) and the landing
 * (tool-agnostic). `tool` only reorders the list; both tools' links always show.
 */
export function learnMoreSectionHtml(tool?: ToolId): string {
  const items = learnMoreLinks(tool).map(linkItemHtml).join("");
  return `
    <section aria-labelledby="learn-h">
      <h2 id="learn-h">Learn more — spend fewer tokens</h2>
      <ul class="links">${items}</ul>
    </section>`;
}
