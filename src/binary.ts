import * as fs from "fs";

// Common Homebrew install locations to probe when the CLI isn't on PATH or
// configured explicitly. Used by session restore (`promptconduit sessions`);
// the cost feed no longer needs a binary — it reads events.jsonl directly.
const FALLBACK_BINARY_PATHS = [
  "/opt/homebrew/bin/promptconduit",
  "/usr/local/bin/promptconduit",
];

/**
 * Resolve the promptconduit CLI binary: explicit config, then a set of common
 * absolute locations. Returns "promptconduit" (bare) as a last resort so the
 * OS PATH still gets a chance. Returns null only if a configured path is set
 * but missing.
 */
export function resolveBinary(configuredPath: string): string | null {
  if (configuredPath) {
    return fs.existsSync(configuredPath) ? configuredPath : null;
  }
  for (const p of FALLBACK_BINARY_PATHS) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return "promptconduit"; // rely on PATH resolution at spawn time
}
