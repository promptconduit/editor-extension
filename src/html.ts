// Tiny, dependency-free HTML helpers for server-rendered webview markup.
// Centralised so escaping is identical everywhere.

/** Escape the five HTML-significant characters for safe text/attribute interpolation. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
