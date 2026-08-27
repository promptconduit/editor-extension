// Local cost aggregation by session, git branch, or open PR. Pure logic — no
// vscode import — sums ConversationStore totals from envelopes' vcs context.

import { ConversationStore, ConversationView } from "./state";

export type CostScope = "session" | "branch" | "pr";

export interface ScopeChip {
  id: CostScope;
  label: string;
  active: boolean;
  disabled?: boolean;
}

export interface ScopeTotals {
  usd: number;
  hasUnpriced: boolean;
  kicker: string;
}

/** Strip conventional branch prefixes for display (feat/, fix/, chore/, …). */
export function stripBranchPrefix(branch: string): string {
  return branch.replace(/^(feat|fix|chore|refactor|docs)\//, "");
}

function sumViews(views: ConversationView[]): { usd: number; hasUnpriced: boolean } {
  let usd = 0;
  let hasUnpriced = false;
  for (const v of views) {
    const t = v.summary.totals;
    if (t.cost_total > 0) {
      usd += t.cost_total;
    }
    if (v.summary.by_model.some((m) => !m.model_priced)) {
      hasUnpriced = true;
    }
  }
  return { usd, hasUnpriced };
}

function viewsForBranch(store: ConversationStore, branch: string, repo?: string): ConversationView[] {
  return store.list().filter((v) => {
    if (!v.vcs?.branch || v.vcs.branch !== branch) {
      return false;
    }
    if (repo && v.vcs.repo && v.vcs.repo !== repo) {
      return false;
    }
    return true;
  });
}

function viewsForPr(store: ConversationStore, prNumber: number, repo?: string): ConversationView[] {
  return store.list().filter((v) => {
    if (v.vcs?.pr?.number !== prNumber) {
      return false;
    }
    if (repo && v.vcs.repo && v.vcs.repo !== repo) {
      return false;
    }
    return true;
  });
}

/** Build scope chip metadata for the cost panel toolbar. */
export function scopeChips(store: ConversationStore, scope: CostScope): ScopeChip[] {
  const display = store.displayKey ? store.viewForKey(store.displayKey) : undefined;
  const branch = display?.vcs?.branch;
  const pr = display?.vcs?.pr?.number;
  const branchLabel = branch ? stripBranchPrefix(branch) : "This branch";
  return [
    { id: "session", label: "Session", active: scope === "session" },
    {
      id: "branch",
      label: branch ? branchLabel : "This branch",
      active: scope === "branch",
      disabled: !branch,
    },
    {
      id: "pr",
      label: pr ? `PR #${pr}` : "This PR",
      active: scope === "pr",
      disabled: pr === undefined,
    },
  ];
}

/** Aggregate cost totals for the selected scope. */
export function aggregateScope(
  store: ConversationStore,
  scope: CostScope,
): ScopeTotals {
  const displayKey = store.displayKey;
  const display = displayKey ? store.viewForKey(displayKey) : undefined;
  const repo = display?.vcs?.repo;

  if (scope === "session" || !display) {
    const t = display?.summary.totals;
    const hasUnpriced = display?.summary.by_model.some((m) => !m.model_priced) ?? false;
    return {
      usd: t?.cost_total ?? 0,
      hasUnpriced,
      kicker: "This session would cost",
    };
  }

  if (scope === "branch") {
    const branch = display.vcs?.branch;
    if (!branch) {
      return { usd: 0, hasUnpriced: false, kicker: "This session would cost" };
    }
    const { usd, hasUnpriced } = sumViews(viewsForBranch(store, branch, repo));
    return {
      usd,
      hasUnpriced,
      kicker: `On branch ${stripBranchPrefix(branch)}`,
    };
  }

  const pr = display.vcs?.pr?.number;
  if (pr === undefined) {
    return { usd: 0, hasUnpriced: false, kicker: "This session would cost" };
  }
  const { usd, hasUnpriced } = sumViews(viewsForPr(store, pr, repo));
  return {
    usd,
    hasUnpriced,
    kicker: `On PR #${pr}`,
  };
}

/** Branch/PR totals for the status bar tooltip (when vcs context exists). */
export function scopeTooltipLines(store: ConversationStore): string[] {
  const display = store.displayKey ? store.viewForKey(store.displayKey) : undefined;
  if (!display?.vcs) {
    return [];
  }
  const lines: string[] = [];
  const branch = display.vcs.branch;
  const repo = display.vcs.repo;
  if (branch) {
    const { usd, hasUnpriced } = sumViews(viewsForBranch(store, branch, repo));
    const label = hasUnpriced && usd <= 0 ? "unpriced" : usd > 0 ? `$${usd.toFixed(2)}` : "$0.00";
    lines.push(`Branch ${stripBranchPrefix(branch)}: **${label}**`);
  }
  const pr = display.vcs.pr?.number;
  if (pr !== undefined) {
    const { usd, hasUnpriced } = sumViews(viewsForPr(store, pr, repo));
    const label = hasUnpriced && usd <= 0 ? "unpriced" : usd > 0 ? `$${usd.toFixed(2)}` : "$0.00";
    lines.push(`PR #${pr}: **${label}**`);
  }
  return lines;
}
