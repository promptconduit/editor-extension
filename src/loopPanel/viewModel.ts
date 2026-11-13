// Pure builder: ConversationStore → LoopPanelState. No vscode import, so the
// whole panel state is unit-testable; the host posts the result as-is.

import type { ConversationStore, ConversationView } from "../state";
import type { PromptGroup } from "../promptGroup";
import { buildAdvice, buildLedger, type SessionOpening } from "../loop/ledger";
import { compareHistory } from "../loop/history";
import { appMarketingUrl, coachingArticleUrl } from "../marketingUrl";
import type { AgentHint, GrowthPoint, LoopPanelState, LoopPromptRow, LoopSession } from "./protocol";
import type { SetupState } from "../setup";

const MAX_PROMPTS = 60;
const MAX_GROWTH = 2000;

let revision = 0;

export interface LoopSelection {
  /** A prompt the user picked; ignored when followLatest is on. */
  promptId?: string;
  followLatest: boolean;
}

function ms(ts: string | undefined): number {
  const v = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(v) ? 0 : v;
}

function row(g: PromptGroup): LoopPromptRow {
  const after = new Set(g.afterPromptRequestIds ?? []);
  return {
    id: g.id,
    text: (g.promptText ?? (g.kind === "preamble" ? "(before the first prompt)" : "(prompt not captured)"))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120),
    ts: g.startedAt ?? g.requests[0]?.ts,
    usd: g.requests.filter((r) => !after.has(r.request_id)).reduce((a, r) => a + r.cost.total, 0),
    roundTrips: g.requests.filter((r) => !after.has(r.request_id)).length,
    kind: g.taskKind ?? "other",
    live: g.kind === "prompt" && !g.endedAt,
  };
}

function growthOf(prompts: PromptGroup[]): { growth: GrowthPoint[]; opening?: SessionOpening } {
  const reqs = prompts.flatMap((g) => g.requests).sort((a, b) => ms(a.ts) - ms(b.ts));
  const growth: GrowthPoint[] = reqs.map((r) => [
    r.ts,
    r.tokens.input + r.tokens.cache_read + r.tokens.cache_write,
    r.cost.total,
    r.cost.cache_read,
    r.cost.cache_write + r.cost.input,
    r.cost.output,
  ]);
  const first = reqs[0];
  const opening = first
    ? {
        firstCallUsd: first.cost.total,
        firstCallContext: first.tokens.input + first.tokens.cache_read + first.tokens.cache_write,
      }
    : undefined;
  return { growth: growth.slice(-MAX_GROWTH), opening };
}

function sessionOf(v: ConversationView): LoopSession {
  const prompts = v.prompts ?? [];
  const { growth, opening } = growthOf(prompts);
  const where = [v.vcs?.repo, v.vcs?.branch].filter(Boolean).join(" · ") || undefined;
  return {
    key: v.key,
    tool: v.tool,
    where,
    totalUsd: v.summary.totals.cost_total,
    prompts: prompts
      .filter((g) => g.kind === "prompt" || g.requests.length > 0)
      .map(row)
      .reverse()
      .slice(0, MAX_PROMPTS),
    growth,
    promptMarks: prompts
      .filter((g) => g.kind === "prompt" && g.startedAt)
      .map((g) => [g.startedAt!, g.id] as [string, string]),
    opening,
  };
}

/** The prompt to show: the picked one, else the newest with priced calls (or the live one). */
function pick(prompts: PromptGroup[], sel: LoopSelection): PromptGroup | undefined {
  if (!sel.followLatest && sel.promptId) {
    const g = prompts.find((p) => p.id === sel.promptId);
    if (g) return g;
  }
  for (let i = prompts.length - 1; i >= 0; i--) {
    const g = prompts[i];
    if (g.requests.length > 0 || (g.kind === "prompt" && !g.endedAt)) return g;
  }
  return prompts[prompts.length - 1];
}

/** Host-provided extras: account state, the agent hint and first-run setup. */
export interface LoopExtras {
  signedIn?: boolean;
  agentHint?: AgentHint;
  setup?: SetupState;
}

export function buildLoopPanelState(
  store: ConversationStore,
  sel: LoopSelection,
  syncOffer?: LoopPanelState["syncOffer"],
  extras: LoopExtras = {},
): LoopPanelState {
  revision += 1;
  const base: LoopPanelState = {
    revision,
    focusSource: store.focusSource,
    followLatest: sel.followLatest,
    advice: [],
    guideBase: coachingArticleUrl(""),
    teamUrl: appMarketingUrl("/team", "cost_panel", "loop_team_compare"),
    signedIn: extras.signedIn ?? false,
    ...(syncOffer ? { syncOffer } : {}),
    ...(extras.agentHint ? { agentHint: extras.agentHint } : {}),
    ...(extras.setup ? { setup: extras.setup } : {}),
  };
  const key = store.displayKey;
  const view = key ? store.viewForKey(key) : undefined;
  if (!view) return base;

  const session = sessionOf(view);
  const prompts = view.prompts ?? [];
  const current = pick(prompts, sel);
  if (!current) return { ...base, session };

  const ledger = buildLedger(current);
  const advice = ledger
    ? buildAdvice(ledger, session.opening).map((a) => ({
        ...a,
        ...(a.guideSlug ? { guideUrl: coachingArticleUrl(a.guideSlug) } : {}),
      }))
    : [];
  const all = store.list().flatMap((v) => v.prompts ?? []);
  const subs = current.subagents;
  return {
    ...base,
    session,
    selectedPromptId: current.id,
    promptText: current.promptText,
    ledger,
    advice,
    history: compareHistory(current, all),
    ...(subs.length > 0
      ? {
          subagents: {
            count: subs.length,
            usd: subs.reduce((a, s) => a + (s.usdTotal ?? 0), 0),
            unpricedRequests: subs.reduce((a, s) => a + (s.unpricedRequests ?? 0), 0),
          },
        }
      : {}),
  };
}
