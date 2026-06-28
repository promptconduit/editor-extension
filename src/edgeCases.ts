// Edge-case explainer for the cost breakdown.
//
// These are DATA caveats — reasons a number might look surprising — paired with
// a concrete way to resolve them, kept separate from tips.ts (which is about
// changing how you work to spend less). The panel renders them under "Reading
// these numbers" so an unpriced or estimated figure never silently reads as
// truth. Pure logic, no `vscode`/HTML, so it unit-tests cleanly.

import { CostEvent, SessionSummary, ToolId } from "./types";
import { LINKS, ResourceLink } from "./links";

// info  — accuracy/context note, nothing to fix (e.g. reconciled counts).
// warn  — the figure is approximate or incomplete; the resolution improves it.
export type EdgeSeverity = "info" | "warn";

export interface EdgeCase {
  /** Stable id, handy for tests and keys. */
  id: string;
  severity: EdgeSeverity;
  /** One-line headline of the caveat. */
  title: string;
  /** What's going on and why the number looks the way it does. */
  detail: string;
  /** The concrete step that resolves or improves it. */
  resolution: string;
  /** Optional supporting doc. */
  link?: ResourceLink;
}

// Resolve the active tool from whichever record we have.
function toolOf(session: SessionSummary | undefined, lastEvent: CostEvent | undefined): ToolId {
  return session?.tool ?? lastEvent?.tool ?? "";
}

// The right pricing reference for the active tool.
function pricingLink(tool: ToolId): ResourceLink {
  return tool === "cursor" ? LINKS.cursorPricing : LINKS.claudeApiPricing;
}

function anyUnpriced(session: SessionSummary | undefined, lastEvent: CostEvent | undefined): boolean {
  if (session && (session.by_model ?? []).some((m) => !m.model_priced)) {
    return true;
  }
  return !!lastEvent && !lastEvent.model_priced;
}

/**
 * Derive the data caveats worth surfacing for the active conversation. Returns
 * [] when the figures are exact and fully priced (the common, clean case), so
 * the panel shows this section only when there's genuinely something to explain.
 * Order is most-actionable first.
 */
export function buildEdgeCases(
  session: SessionSummary | undefined,
  lastEvent: CostEvent | undefined,
): EdgeCase[] {
  const cases: EdgeCase[] = [];
  if (!session && !lastEvent) {
    return cases;
  }

  const tool = toolOf(session, lastEvent);
  const source = session?.source ?? lastEvent?.source;

  // 1. Unpriced model(s): exact tokens, no rate to turn them into dollars.
  if (anyUnpriced(session, lastEvent)) {
    cases.push({
      id: "unpriced",
      severity: "warn",
      title: "Some models aren't in the rate table",
      detail:
        "Their tokens are exact, but with no per-token rate the dollar cost can't be computed, so it's shown as unpriced rather than a misleading $0.00 (this is common for Cursor's composer models).",
      resolution:
        "Run `promptconduit cost refresh-pricing` to pull the latest public rates, or read the token counts as the cost signal.",
      link: pricingLink(tool),
    });
  }

  // 2. Estimate source: counts tokenized locally, not read from a usage block.
  if (source === "estimate") {
    cases.push({
      id: "estimate",
      severity: "warn",
      title: "Token counts are estimated",
      detail:
        "These tokens were counted locally because the source didn't report exact usage (Cursor's native agent), so the cost is a close approximation, not the billed figure.",
      resolution:
        "Install the hooks (`promptconduit install cursor`) so exact token usage is captured going forward.",
      link: LINKS.cursorPricing,
    });
  }

  // 3. Reconciled source: started as an estimate, corrected to provider usage.
  if (source === "reconciled") {
    cases.push({
      id: "reconciled",
      severity: "info",
      title: "Estimated, then reconciled",
      detail:
        "Counts began as a local estimate and were corrected against the provider's reported usage — treat them as accurate.",
      resolution: "No action needed.",
    });
  }

  // 4. Estimate-not-a-bill caveat: priced figures are computed locally at public
  //    API rates, which a subscription typically already covers. Shown whenever
  //    there's real priced spend so the headline dollar figure is never mistaken
  //    for an invoice.
  if ((session?.totals.cost_total ?? 0) > 0) {
    cases.push({
      id: "api-equivalent",
      severity: "info",
      title: "This figure is an estimate, not a bill",
      detail:
        "Costs are computed on your machine from token counts at public per-token API rates, so they may differ from your actual invoice. If you're on a Claude or Cursor subscription, this usage is already included — the figure is the à-la-carte API equivalent, not a separate charge.",
      resolution: "For authoritative billing, check your provider's usage dashboard.",
      link: pricingLink(tool),
    });
  }

  return cases;
}
