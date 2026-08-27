// Short zero-state for the cost panel when no sessions exist yet.

import { marketingUrl } from "./marketingUrl";

export function shortLandingHtml(): string {
  return `<header class="hero landing-short">
    <p class="kicker">AI Session Cost</p>
    <p class="hero-cost muted">—</p>
    <p class="muted">100% local. Install PromptConduit hooks, start an AI session, and your cost appears here live.</p>
    <p class="muted small" style="margin-top: 1rem;">
      <a href="${marketingUrl("/docs/getting-started", "cost_panel", "zero_state")}">Getting started →</a>
    </p>
  </header>`;
}
