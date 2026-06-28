// Canonical external resources for the cost breakdown's educational surfaces.
//
// One registry, used by the tips engine, the edge-case explainer, the panel's
// "Learn more" section, and the zero-state landing — so every link in the UI is
// defined (and verified) in exactly one place. Pure data + small helpers, no
// HTML and no `vscode` import, so it unit-tests cleanly and the renderers stay
// the only thing that knows about markup.
//
// All hrefs are https and were checked to resolve; the Claude docs moved hosts
// (docs.claude.com → platform.claude.com / code.claude.com), so the canonical
// post-redirect URLs are used here to avoid shipping a redirect hop.

import { ToolId } from "./types";

/** A single external resource: where it points, and how to describe it. */
export interface ResourceLink {
  /** Short, clickable label (the anchor text). */
  label: string;
  /** Absolute https URL. */
  href: string;
  /** One-line description of what's there and why it helps cut cost. */
  desc: string;
}

// Anthropic / Claude resources.
const CLAUDE_API_PRICING: ResourceLink = {
  label: "Claude API pricing",
  href: "https://claude.com/pricing#api",
  desc: "The pay-as-you-go per-token rates these estimates are computed against.",
};
const CLAUDE_PROMPT_CACHING: ResourceLink = {
  label: "Prompt caching guide",
  href: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
  desc: "How cached reads work and why they're ~10× cheaper than fresh input.",
};
const CLAUDE_CODE_REDUCE_TOKENS: ResourceLink = {
  label: "Claude Code: reduce token usage",
  href: "https://code.claude.com/docs/en/costs#reduce-token-usage",
  desc: "/clear between tasks, right-size the model, trim context, batch work.",
};
const CLAUDE_CODE_COSTS: ResourceLink = {
  label: "Claude Code: manage costs",
  href: "https://code.claude.com/docs/en/costs",
  desc: "Track spend, set limits, and the full cost-reduction playbook.",
};

// Cursor resources.
const CURSOR_PRICING: ResourceLink = {
  label: "Cursor models & pricing",
  href: "https://cursor.com/docs/models-and-pricing",
  desc: "Per-model rates, the Auto/Composer vs API usage pools, and plan limits.",
};
const CURSOR_DOCS: ResourceLink = {
  label: "Cursor docs",
  href: "https://cursor.com/docs",
  desc: "Model selection, context control, and usage settings.",
};

/** Named registry — import these rather than hand-writing URLs at call sites. */
export const LINKS = {
  claudeApiPricing: CLAUDE_API_PRICING,
  claudePromptCaching: CLAUDE_PROMPT_CACHING,
  claudeCodeReduceTokens: CLAUDE_CODE_REDUCE_TOKENS,
  claudeCodeCosts: CLAUDE_CODE_COSTS,
  cursorPricing: CURSOR_PRICING,
  cursorDocs: CURSOR_DOCS,
} as const;

const CLAUDE_RESOURCES: ResourceLink[] = [
  CLAUDE_API_PRICING,
  CLAUDE_PROMPT_CACHING,
  CLAUDE_CODE_REDUCE_TOKENS,
  CLAUDE_CODE_COSTS,
];

const CURSOR_RESOURCES: ResourceLink[] = [CURSOR_PRICING, CURSOR_DOCS];

/**
 * The full "Learn more" set, ordered so the active tool's docs come first.
 * BOTH tools' resources are always included — a workspace can drive Claude Code
 * and Cursor from the same window, and the panel is meant to teach either, so we
 * never hide one tool's links just because the latest turn came from the other.
 * Passing no tool (zero-state landing) leads with Claude, then Cursor.
 */
export function learnMoreLinks(tool?: ToolId): ResourceLink[] {
  if (tool === "cursor") {
    return [...CURSOR_RESOURCES, ...CLAUDE_RESOURCES];
  }
  return [...CLAUDE_RESOURCES, ...CURSOR_RESOURCES];
}

/**
 * True only for an absolute http(s) URL. The webview runs with scripts disabled,
 * but anchors are still rendered into HTML, so this gates out `javascript:`,
 * `data:`, and other non-navigational schemes before a link is emitted. Every
 * link in {@link LINKS} is static and https; this guards the render path itself
 * so a future dynamic href can't smuggle in an unsafe scheme.
 */
export function isSafeHttpUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}
