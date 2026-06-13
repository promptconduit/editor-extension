# Changelog

## 0.1.0

- Initial release. Realtime token-cost in the editor status bar — request cost
  and session cost — with a click-through webview breakdown (per-model;
  input / output / cache-read / cache-write tokens).
- Works for **Claude Code** and **Cursor**, driven by the `promptconduit cost
  watch --json` stream. 100% local — no data leaves the machine.
- Models without a known rate (e.g. Cursor's `composer-*`) show exact tokens,
  labeled "unpriced," instead of a misleading `$0.00`.
