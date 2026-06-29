// Bundled coaching content. Shipped INSIDE the extension so the coaching tips
// render in full with no network — the offline-first requirement. Each article
// mirrors a markdown file under platform/app/web/content/coaching/<slug>.md
// (same slug, same insightType); the online link is the canonical full article.
//
// Keep the slugs in lockstep with contract.ts INSIGHT_SLUGS and the web content.

import { COACHING_SITE_BASE, INSIGHT_SLUGS } from "./contract";

export interface CoachingArticle {
  type: string; // canonical insight type
  slug: string;
  title: string;
  summary: string; // one-line, shown next to the insight
  body: string[]; // short paragraphs, shown in an expandable <details>
  url: string; // absolute https URL to the full article
}

function article(type: string, title: string, summary: string, body: string[]): CoachingArticle {
  const slug = INSIGHT_SLUGS[type] ?? type;
  return { type, slug, title, summary, body, url: `${COACHING_SITE_BASE}/${slug}` };
}

export const ARTICLES: Record<string, CoachingArticle> = {
  high_interruption_rate: article(
    "high_interruption_rate",
    "Reduce interruptions",
    "You're stopping the agent mid-task a lot — front-load the context instead.",
    [
      "An interruption is a prompt you send while the agent is still working. A few are normal; a high rate usually means the first prompt was under-specified, so you course-correct mid-flight.",
      "Cost: every interruption discards in-flight work and re-reads context, so it burns tokens and breaks the agent's plan. It also tends to produce shallower results because the agent never finishes a thought.",
      "Fix: spend 20 extra seconds on the opening prompt — state the goal, the constraints, and the done condition. Use plan mode for anything non-trivial so you approve the approach before work starts, then let it run.",
    ],
  ),
  low_plan_mode_adoption: article(
    "low_plan_mode_adoption",
    "Use plan mode for non-trivial work",
    "Most of your prompts ran in auto mode — plan mode catches wrong approaches before they cost tokens.",
    [
      "Plan mode makes the agent research and propose an approach before editing anything. You approve or redirect, then it executes. It's the single highest-leverage habit for multi-step work.",
      "When to use it: anything touching more than one or two files, anything you're unsure how to scope, or anything where a wrong approach is expensive to unwind.",
      "When to skip it: tiny, obvious edits where planning is slower than just doing it.",
    ],
  ),
  subagent_underuse: article(
    "subagent_underuse",
    "Delegate with subagents",
    "You rarely spawn subagents — parallel agents cover more ground and keep your main context clean.",
    [
      "Subagents run independent tasks in their own context window and report back a conclusion. They're ideal for broad searches, multi-file audits, and anything you'd otherwise do serially.",
      "Two wins: parallelism (3 explorers finish in the time of 1) and context hygiene (the file dumps stay in the subagent, so your main session doesn't bloat and trigger compaction).",
      "Fix: when a task decomposes into independent pieces, launch one subagent per piece in a single message so they run concurrently.",
    ],
  ),
  worktree_opportunity: article(
    "worktree_opportunity",
    "Isolate risky work in a worktree",
    "Heavy multi-file sessions are safer in a git worktree — experiment without touching your main checkout.",
    [
      "A worktree is a second working copy of the repo on its own branch. The agent can refactor freely there while your primary checkout stays clean and buildable.",
      "It's the safe way to let an agent run a large or speculative change: if it goes wrong, you delete the worktree; if it goes right, you merge the branch.",
      "Fix: for large refactors or anything you might throw away, start the session in a dedicated worktree/branch.",
    ],
  ),
  low_slash_command_adoption: article(
    "low_slash_command_adoption",
    "Adopt skills and slash-commands",
    "You type long prompts for repeatable work — capture them as skills/slash-commands instead.",
    [
      "Skills and slash-commands package a repeatable workflow (review a PR, ship a branch, run an audit) into one invocation with a tested, consistent prompt.",
      "Benefit: less typing, fewer under-specified prompts, and the same high-quality instructions every time instead of whatever you remember to write.",
      "Fix: notice the prompts you write again and again, and turn the top few into skills.",
    ],
  ),
  mcp_imbalance: article(
    "mcp_imbalance",
    "Right-size your MCP servers",
    "Your MCP usage looks lopsided — connect the servers you actually use and prune the rest.",
    [
      "MCP servers give the agent real tools (databases, browsers, APIs). The right ones remove guesswork; too many unused ones add tool-selection overhead and token cost in every prompt.",
      "Fix: connect MCP servers for the systems you genuinely work with, and disconnect ones you never call. Lean on a server's tools instead of scripting around them by hand.",
    ],
  ),
  low_cache_hit: article(
    "low_cache_hit",
    "Improve your cache hit rate",
    "A lot of your input wasn't a cache hit — reuse context instead of re-pasting it.",
    [
      "Cached reads cost roughly 10× less than fresh input. A low hit rate means you're paying full price for context the model has effectively already seen.",
      "Fix: keep one session going for a task instead of restarting, and avoid re-pasting large files the agent already read — let the cache carry them across turns.",
    ],
  ),
  low_tool_success: article(
    "low_tool_success",
    "Raise your tool success rate",
    "A noticeable share of tool calls failed — failed calls waste a full round-trip each.",
    [
      "Every failed tool call (a bad command, a wrong path, an interrupted run) costs a round-trip and some output tokens, then needs another call to recover.",
      "Fix: give the agent the context to get tools right the first time — correct paths, working directory, and any environment quirks. Let it read before it writes.",
    ],
  ),
  high_tool_volume: article(
    "high_tool_volume",
    "Batch your tool calls",
    "High tool-call volume per step — grouping related reads/edits cuts round-trips.",
    [
      "Independent tool calls can run in parallel in a single step. Doing them one at a time multiplies round-trips and output tokens.",
      "Fix: ask for related reads/searches together so the agent batches them, and prefer fewer, larger edits over many tiny ones.",
    ],
  ),
};

/** Resolve an insight type to its bundled article (offline) or undefined. */
export function articleFor(type: string): CoachingArticle | undefined {
  return ARTICLES[type];
}
