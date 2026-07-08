// Tiny JSON syntax highlighter for the raw-event inspector. Pure string ->
// string; escapes EVERYTHING first (raw payloads are model/user-controlled),
// then wraps tokens in theme-variable spans. No dependencies.

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// Token pattern over ESCAPED text: strings (optionally key-position), numbers,
// booleans/null. Escaped quotes appear as &quot; so match those.
const TOKEN =
  /(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(true|false|null)\b/g;

/**
 * Pretty JSON text -> highlighted HTML. Feed it the already-pretty-printed
 * string (the extension stores raw events as 2-space-indented JSON).
 */
export function highlightJson(pretty: string): string {
  const escaped = escapeHtml(pretty);
  return escaped.replace(TOKEN, (_m, str, colon, num, kw) => {
    if (str !== undefined) {
      return colon !== undefined
        ? `<span class="j-key">${str}</span>${colon}`
        : `<span class="j-str">${str}</span>`;
    }
    if (num !== undefined) {
      return `<span class="j-num">${num}</span>`;
    }
    return `<span class="j-kw">${kw}</span>`;
  });
}
