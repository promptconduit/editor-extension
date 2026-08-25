// UTM-tagged links to promptconduit.dev from the extension UI.
//
// Used only on user-clicked outbound links (not background telemetry). Lets us
// attribute extension funnel traffic in analytics without changing the
// extension's "no data leaves your machine" promise for cost tracking.

const SITE_BASE = "https://promptconduit.dev";

export type MarketingMedium =
  | "cost_panel"
  | "coaching"
  | "status_bar"
  | "command";

/** Build a promptconduit.dev URL with standard extension UTM params. */
export function marketingUrl(
  path = "",
  medium: MarketingMedium,
  campaign: string,
): string {
  const base = path ? `${SITE_BASE}${path.startsWith("/") ? path : `/${path}`}` : SITE_BASE;
  const params = new URLSearchParams({
    utm_source: "extension",
    utm_medium: medium,
    utm_campaign: campaign,
  });
  return `${base}?${params.toString()}`;
}

/** Coaching article on the marketing site with coaching UTM params. */
export function coachingArticleUrl(slug: string): string {
  return marketingUrl(`/coaching/${slug}`, "coaching", slug);
}

/** App URL with extension UTM params (app.promptconduit.dev). */
export function appMarketingUrl(
  path = "",
  medium: MarketingMedium,
  campaign: string,
): string {
  const base = `https://app.promptconduit.dev${path ? (path.startsWith("/") ? path : `/${path}`) : ""}`;
  const params = new URLSearchParams({
    utm_source: "extension",
    utm_medium: medium,
    utm_campaign: campaign,
  });
  return `${base}?${params.toString()}`;
}
