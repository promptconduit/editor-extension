import * as cp from "child_process";
import * as fs from "fs";
import * as readline from "readline";
import { CostRecord, parseRecord } from "./types";

// Common Homebrew install locations to probe when the CLI isn't on PATH or
// configured explicitly.
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

export interface WatcherCallbacks {
  onRecord: (rec: CostRecord) => void;
  onError: (message: string) => void;
}

/**
 * CostWatcher spawns `promptconduit cost watch --json` for a workspace and
 * streams parsed cost records to the caller. It restarts the child if it exits
 * unexpectedly (debounced) so a transient hiccup doesn't silently stop updates.
 */
export class CostWatcher {
  private child: cp.ChildProcessWithoutNullStreams | undefined;
  private stopped = false;
  private restartTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly binary: string,
    private readonly cwd: string,
    private readonly callbacks: WatcherCallbacks,
  ) {}

  start(): void {
    this.stopped = false;
    this.spawn();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (this.child) {
      this.child.kill();
      this.child = undefined;
    }
  }

  private spawn(): void {
    if (this.stopped) {
      return;
    }
    let child: cp.ChildProcessWithoutNullStreams;
    try {
      child = cp.spawn(this.binary, ["cost", "watch", "--json", "--cwd", this.cwd], {
        cwd: this.cwd,
      });
    } catch (err) {
      this.callbacks.onError(`failed to start cost watcher: ${String(err)}`);
      return;
    }
    this.child = child;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const rec = parseRecord(line);
      if (rec) {
        this.callbacks.onRecord(rec);
      }
    });

    child.on("error", (err) => {
      this.callbacks.onError(`cost watcher error: ${err.message}`);
    });

    child.on("exit", () => {
      rl.close();
      this.child = undefined;
      if (this.stopped) {
        return;
      }
      // Debounced restart — guards against a tight crash loop.
      this.restartTimer = setTimeout(() => this.spawn(), 2000);
    });
  }
}
