# Changelog

## 0.2.0

- Upgraded to cost-feed **schema v2**: the breakdown now shows a per-request
  drill-down (tools called, token split, and per-request cost) and a
  **"Reduce your cost"** section with actionable tips derived from the CLI's
  cost-reduction signals (cache-hit rate, fresh-input share, model tier,
  tool-call volume).
- **Forward-compatible parser**: the extension now accepts any cost record with
  `v >= 1` and reads fields defensively (the cost-feed contract is
  additive-only), so a newer auto-updated CLI never blanks the panel.
- Carries Cursor's `conversation_id` through for upcoming per-tab cost.

## 0.1.0

- Initial release. Realtime token-cost in the editor status bar — request cost
  and session cost — with a click-through webview breakdown (per-model;
  input / output / cache-read / cache-write tokens).
- Works for **Claude Code** and **Cursor**, driven by the `promptconduit cost
  watch --json` stream. 100% local — no data leaves the machine.
- Models without a known rate (e.g. Cursor's `composer-*`) show exact tokens,
  labeled "unpriced," instead of a misleading `$0.00`.
