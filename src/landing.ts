// Zero-state landing content for the cost webview.
//
// When the active conversation has no priced turns yet, there is nothing to
// chart, so the panel shows this "what am I looking at" view instead of an
// empty table. `landingHtml()` returns only the INNER <body> markup — the panel
// integration step wraps it in the exact same document shell + CSP that
// panel.ts builds (DOCTYPE, <head>, <meta charset>, theme <style>). It must
// stay script-free: the webview runs with `enableScripts: false`, so all
// interactivity is plain HTML, and external links open in the user's default
// browser without any JS. Styling reuses the panel's inline-CSS theme
// conventions (var(--vscode-...) variables) so light/dark themes match.

/**
 * Inner HTML body for the cost webview's zero-state ("no cost yet") view.
 *
 * Pure, dependency-free renderer: takes no arguments and contains no
 * JavaScript. The panel integration injects the return value into the same
 * document shell/CSP used by {@link CostPanel}. Covers three sections:
 *   1. What PromptConduit / this extension is + the 100%-local privacy promise.
 *   2. "Learn more" external links (open in the default browser).
 *   3. PromptConduit Pro / Team upsell (marketing copy only).
 */
export function landingHtml(): string {
  return `
  <style>
    .landing { max-width: 44rem; }
    .landing h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
    .landing .lede { color: var(--vscode-descriptionForeground); margin: 0 0 1.25rem; font-size: 0.95rem; }
    .landing h2 { font-size: 0.95rem; margin: 1.5rem 0 0.5rem; }
    .landing p { margin: 0.4rem 0; line-height: 1.5; }
    .card { padding: 0.85rem 1rem; margin-top: 0.6rem; border: 1px solid var(--vscode-panel-border);
            border-radius: 0.5rem; background: var(--vscode-textBlockQuote-background); }
    .privacy { border-left: 3px solid var(--vscode-textLink-foreground); }
    .privacy strong { display: block; margin-bottom: 0.2rem; }
    .steps { margin: 0.5rem 0 0; padding-left: 1.2rem; }
    .steps li { margin: 0.3rem 0; line-height: 1.45; }
    .links { list-style: none; padding: 0; margin: 0.5rem 0 0; }
    .links li { margin: 0.35rem 0; }
    .links a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .links a:hover { text-decoration: underline; }
    .links .desc { color: var(--vscode-descriptionForeground); }
    .upsell { border-left: 3px solid var(--vscode-textLink-foreground); }
    .upsell h2 { margin-top: 0; }
    .feat { list-style: none; padding: 0; margin: 0.6rem 0 0; }
    .feat li { margin: 0.5rem 0; line-height: 1.45; }
    .feat strong { display: block; }
    .feat .desc { color: var(--vscode-descriptionForeground); }
    .cta { display: inline-block; margin-top: 0.85rem; color: var(--vscode-textLink-foreground);
           text-decoration: none; font-weight: 600; }
    .cta:hover { text-decoration: underline; }
    .muted { color: var(--vscode-descriptionForeground); }
  </style>

  <main class="landing">
    <h1>AI Session Cost</h1>
    <p class="lede">No priced turns in this conversation yet. Start working with your
      AI assistant and the cost will appear here — and live in the status bar.</p>

    <section aria-labelledby="about-h">
      <h2 id="about-h">What this is</h2>
      <p><strong>PromptConduit</strong> shows what your AI coding sessions actually
        cost. This extension prices every turn — input, output, and cache tokens —
        and surfaces the running total live in the status bar, with a click-through
        breakdown by model and request.</p>

      <div class="card privacy">
        <strong>100% local — no data leaves your machine.</strong>
        Costs are computed entirely on your device from your local AI transcripts.
        Nothing is uploaded, no account is required, and no telemetry is sent.
      </div>

      <h2>How cost tracking works</h2>
      <p>The extension reads the local <code>promptconduit cost watch</code> stream,
        scoped to your workspace. The CLI reads your AI transcripts on disk, prices
        each turn against a bundled rate table, and emits cost records on stdout —
        all on your machine.</p>
      <ol class="steps">
        <li>Your AI assistant writes a transcript locally as you work.</li>
        <li>The CLI prices each new turn and streams a cost record.</li>
        <li>This panel renders it — totals, per-model rows, per-request detail.</li>
      </ol>
    </section>

    <section aria-labelledby="learn-h">
      <h2 id="learn-h">Learn more</h2>
      <ul class="links">
        <li>
          <a href="https://github.com/promptconduit">github.com/promptconduit</a>
          <span class="desc"> — source, issues, and the open-source CLI.</span>
        </li>
        <li>
          <a href="https://promptconduit.dev">promptconduit.dev</a>
          <span class="desc"> — docs and product home.</span>
        </li>
      </ul>
    </section>

    <section class="card upsell" aria-labelledby="pro-h">
      <h2 id="pro-h">PromptConduit Pro &amp; Team</h2>
      <p>The free extension shows the cost of the session in front of you. Pro and
        Team add the long view across every session, and work with the tools you
        already use — Claude Code, Cursor, and more.</p>
      <ul class="feat">
        <li>
          <strong>Cross-session observability</strong>
          <span class="desc">Every session in one place instead of one tab at a time.</span>
        </li>
        <li>
          <strong>History &amp; cost trends</strong>
          <span class="desc">See where spend is going over days and weeks, not just right now.</span>
        </li>
        <li>
          <strong>Session replay</strong>
          <span class="desc">Step back through a session to see what drove the cost.</span>
        </li>
        <li>
          <strong>Team cost rollups</strong>
          <span class="desc">Roll spend up across a whole team, per project and per model.</span>
        </li>
      </ul>
      <a class="cta" href="https://promptconduit.dev">Explore Pro &amp; Team at promptconduit.dev &rarr;</a>
    </section>

    <p class="muted" style="margin-top: 1.5rem;">
      Computed entirely on your machine from local transcripts. None of your data is sent anywhere.
    </p>
  </main>`;
}
