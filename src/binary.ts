import * as fs from "fs";
import * as path from "path";

// Common install locations to probe when the CLI isn't on PATH or
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

export interface LocateOptions {
  pathEnv?: string;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
}

/**
 * Like resolveBinary, but returns null when the CLI can't actually be found:
 * checks the configured path, every PATH entry, then the common install
 * locations. Used to tell "not installed" from "installed", so it never falls
 * back to a bare name.
 */
export function locateBinary(configuredPath: string, opts: LocateOptions = {}): string | null {
  const exists = opts.exists ?? fs.existsSync;
  if (configuredPath) {
    return exists(configuredPath) ? configuredPath : null;
  }
  const platform = opts.platform ?? process.platform;
  const win = platform === "win32";
  const names = win ? ["promptconduit.exe", "promptconduit"] : ["promptconduit"];
  const join = win ? path.win32.join : path.posix.join;
  const dirs = (opts.pathEnv ?? process.env.PATH ?? "").split(win ? ";" : ":").filter((d) => d.trim() !== "");
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  if (!win) {
    for (const p of FALLBACK_BINARY_PATHS) {
      if (exists(p)) {
        return p;
      }
    }
  }
  return null;
}
