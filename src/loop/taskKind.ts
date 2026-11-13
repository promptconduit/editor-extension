// Task kind of a prompt: what sort of work it asked for. The CLI computes this
// at prompt submission (`prompt.task_kind`) so prompt text never has to leave
// the machine; this classifier mirrors the CLI's rules so prompts captured
// before the CLI shipped the field still group correctly. Keep the RULES table
// in sync with cli/internal/enrich (see docs/specs/the-loop.md in the workspace).

export type TaskKind =
  | "ship"
  | "debug"
  | "build"
  | "refactor"
  | "test"
  | "docs"
  | "review"
  | "explore"
  | "chore"
  | "other";

export const TASK_KINDS: readonly TaskKind[] = [
  "ship",
  "debug",
  "build",
  "refactor",
  "test",
  "docs",
  "review",
  "explore",
  "chore",
  "other",
];

/** Human label for a kind, used in headings ("your ship tasks"). */
export const TASK_KIND_LABEL: Record<TaskKind, string> = {
  ship: "ship",
  debug: "debugging",
  build: "build",
  refactor: "refactor",
  test: "testing",
  docs: "docs",
  review: "review",
  explore: "exploration",
  chore: "chore",
  other: "other",
};

// Ordered: the earliest match in the prompt wins, ties broken by rule order.
const RULES: { kind: TaskKind; re: RegExp }[] = [
  { kind: "ship", re: /\b(merge|ship|publish|deploy|release|cut v\d|tag v?\d|land (it|this|the)|push it|open (a|the) pr|submit (it|the))/i },
  { kind: "debug", re: /\b(fix|bug|error|broken|failing|fails|why (is|does|did)|doesn'?t work|crash|regression)/i },
  { kind: "test", re: /\b(tests?|coverage|e2e|spec)\b/i },
  { kind: "refactor", re: /\b(refactor|rename|clean ?up|simplify|extract)/i },
  { kind: "docs", re: /\b(docs?|readme|changelog|document|write up|blog post|draft)\b/i },
  { kind: "review", re: /\b(review|audit|look over|check|verify|ensure|confirm)\b/i },
  { kind: "explore", re: /\b(how (does|do|can)|where (is|are)|explain|what (is|are)|find|investigate|research|plan)\b/i },
  { kind: "chore", re: /\b(bump|upgrade|update deps|dependencies|config|rotate|lint|format)\b/i },
  { kind: "build", re: /\b(add|build|implement|create|make|support|wire up|feature)\b/i },
];

/** True when a prompt is a short follow-up ("yes please") that should inherit. */
export function isFollowUp(text: string): boolean {
  return text.trim().split(/\s+/).filter(Boolean).length <= 3 && classifyRaw(text) === "other";
}

function classifyRaw(text: string): TaskKind {
  let best: { kind: TaskKind; at: number; order: number } | undefined;
  RULES.forEach((r, order) => {
    const m = r.re.exec(text);
    if (m && (!best || m.index < best.at || (m.index === best.at && order < best.order))) {
      best = { kind: r.kind, at: m.index, order };
    }
  });
  return best?.kind ?? "other";
}

/**
 * Classify a prompt. `previous` is the kind of the prior prompt in the same
 * session; short follow-ups inherit it.
 */
export function classifyTask(text: string | undefined, previous?: TaskKind): TaskKind {
  const t = (text ?? "").trim();
  if (!t) return previous ?? "other";
  if (previous && isFollowUp(t)) return previous;
  return classifyRaw(t);
}

/** Validate a wire value from the CLI's `prompt.task_kind`. */
export function asTaskKind(v: unknown): TaskKind | undefined {
  return typeof v === "string" && (TASK_KINDS as readonly string[]).includes(v)
    ? (v as TaskKind)
    : undefined;
}
