// Metric glossary for the Cost Breakdown detail report: plain-language,
// engineer-facing definitions surfaced as educational tooltips next to each
// figure. Pure data + one lookup helper — no vscode import, no HTML — so the
// renderer stays the only thing that knows about markup.
//
// Hrefs come from the shared LINKS registry (src/links.ts), which is the one
// place external URLs are defined and verified.

import { LINKS } from "../links";

/** One tooltip's worth of educational content for a metric or label. */
export interface GlossaryEntry {
  /** Human-readable name shown as the tooltip's title. */
  term: string;
  /** 1-2 sentence plain-language definition. */
  short: string;
  /** Optional "learn more" URL (absolute https, from LINKS). */
  href?: string;
}

export const GLOSSARY: Record<string, GlossaryEntry> = {
  // --- Token buckets ---------------------------------------------------
  input_tokens: {
    term: "Input tokens",
    short:
      "Fresh (uncached) tokens sent to the model — your prompt, context, and tool results that weren't served from cache. These are billed at the full input rate.",
  },
  output_tokens: {
    term: "Output tokens",
    short:
      "Tokens the model generates in its responses. Output is usually the most expensive per-token rate, so verbose answers cost more than long prompts.",
  },
  cache_read: {
    term: "Cache read tokens",
    short:
      "Tokens replayed from the provider's prompt cache at roughly 0.1× the input rate. A high cache-read share is good — it means your context is being reused, not re-billed.",
    href: LINKS.claudePromptCaching.href,
  },
  cache_write: {
    term: "Cache write tokens",
    short:
      "Tokens written into the prompt cache at a premium: 1.25× the input rate for the 5-minute TTL, 2× for the 1-hour TTL. The write pays for itself once the cached prefix is reused.",
    href: LINKS.claudePromptCachingPricing.href,
  },

  // --- Derived ratios ---------------------------------------------------
  cache_hit_rate: {
    term: "Cache hit rate",
    short:
      "The share of prompt tokens served from cache instead of billed fresh. A low value on a long session usually means context is being rebuilt from scratch each turn.",
    href: LINKS.claudePromptCaching.href,
  },
  fresh_input_share: {
    term: "Fresh input share",
    short:
      "The share of prompt tokens paid at the full input rate (not cached). The mirror of cache hit rate — lower is cheaper.",
  },
  tier: {
    term: "Model tier",
    short:
      "A rough price class for the model — economy, standard, or premium — derived from its name. It's a hint for right-sizing, not a capability score.",
  },

  // --- Claude Code permission modes -------------------------------------
  permission_mode_plan: {
    term: "Plan mode",
    short:
      "Claude Code's read-only planning mode: the agent explores and proposes a plan but makes no changes until you approve it.",
    href: LINKS.claudeCodePermissionModes.href,
  },
  permission_mode_auto: {
    term: "Auto mode",
    short:
      "The harness picks the permission behavior for you, deciding per action how much to auto-approve.",
    href: LINKS.claudeCodePermissionModes.href,
  },
  permission_mode_acceptEdits: {
    term: "Accept-edits mode",
    short:
      "File edits are auto-approved, so the agent can modify code without prompting; other actions still ask for permission.",
    href: LINKS.claudeCodePermissionModes.href,
  },
  permission_mode_default: {
    term: "Default mode",
    short:
      "The standard interactive mode: Claude Code prompts you for permission before edits and commands.",
    href: LINKS.claudeCodePermissionModes.href,
  },
  permission_mode_bypassPermissions: {
    term: "Bypass-permissions mode",
    short:
      "Everything is auto-approved — no permission prompts at all. Fast, but use with care: the agent can run any command unattended.",
    href: LINKS.claudeCodePermissionModes.href,
  },

  // --- Session structure -------------------------------------------------
  subagent: {
    term: "Subagent",
    short:
      "A delegated agent run inside the session with its own context window and its own token cost. Its tokens are billed to the session, so heavy subagent use shows up here.",
    href: LINKS.claudeCodeSubagents.href,
  },
  mcp_server: {
    term: "MCP server",
    short:
      "A Model Context Protocol server that exposes external tools (databases, browsers, APIs) to the agent. Tool schemas and results flow through the context, so they count as tokens.",
    href: LINKS.mcpIntro.href,
  },

  // --- Cost provenance ---------------------------------------------------
  model_unpriced: {
    term: "Unpriced model",
    short:
      "The pricing table has no per-token rate for this model, so the token counts are exact but the dollar figure shows as unpriced instead of a guess.",
  },
  source_exact: {
    term: "Exact cost",
    short:
      "The provider reported this usage directly, so the cost is computed from exact token counts — not an estimate.",
  },
  source_estimate: {
    term: "Estimated cost",
    short:
      "This number was estimated (for example, from partial usage data or approximated tokens) and may differ slightly from what the provider bills.",
  },
  source_reconciled: {
    term: "Reconciled cost",
    short:
      "An earlier estimate that was later corrected against provider-reported usage, so the figure now reflects actual billed tokens.",
  },
};

/** Look up a glossary entry by key; undefined when the key has no entry. */
export function glossaryFor(key: string): GlossaryEntry | undefined {
  return GLOSSARY[key];
}
