// Best-effort tracker for the focused Cursor agent tab.
//
// Cursor exposes no extension API for its chat/agent tabs (they live inside a
// closed-source workbench view, invisible to vscode.window.tabGroups). The one
// dependable side-channel is the workspace storage SQLite database:
//
//   <workspaceStorage>/<hash>/state.vscdb
//     → ItemTable key 'composer.composerData'
//     → JSON { lastFocusedComposerIds: [ <focused first>, … ] }
//
// composerId is the same id the Cursor hooks report as conversation_id, which
// is exactly how the extension already keys Cursor sessions — so the focused
// composerId IS the session key.
//
// This is a heuristic contract with Cursor internals, so the tracker is built
// to fail quietly: read-only queries via the sqlite3 CLI, schema-tolerant
// parsing, and self-disable after repeated failures. It never throws into the
// extension host and never degrades other features. The unit suite pins the
// parsing contract; the schema canary test runs the real query against a real
// SQLite fixture shaped like a live Cursor database.

import { execFile } from "child_process";

/** ItemTable key that holds the chat-tab UI state. */
export const COMPOSER_DATA_KEY = "composer.composerData";

/** SQL executed against the workspace state database (read-only). */
export const COMPOSER_DATA_SQL = `SELECT value FROM ItemTable WHERE key='${COMPOSER_DATA_KEY}';`;

/** Consecutive failures before the tracker turns itself off. */
export const MAX_CONSECUTIVE_FAILURES = 5;

/** Default poll cadence. Workspace storage writes lag tab clicks by a few
 * seconds anyway, so polling faster buys nothing. */
export const POLL_INTERVAL_MS = 2000;

/**
 * Extract the focused composerId from the composer.composerData JSON value.
 * Returns undefined on any shape surprise — schema drift must never throw.
 */
export function parseComposerData(json: string): string | undefined {
  try {
    const obj = JSON.parse(json) as { lastFocusedComposerIds?: unknown };
    if (!obj || typeof obj !== "object") {
      return undefined;
    }
    const ids = obj.lastFocusedComposerIds;
    if (!Array.isArray(ids) || ids.length === 0) {
      return undefined;
    }
    const first = ids[0];
    return typeof first === "string" && first.length > 0 ? first : undefined;
  } catch {
    return undefined;
  }
}

/** Run the composer query via the sqlite3 CLI, read-only (never locks Cursor's
 * live database). Rejects when sqlite3 is missing or the schema changed. */
export function runComposerQuery(dbPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "sqlite3",
      [`file:${dbPath}?mode=ro`, COMPOSER_DATA_SQL],
      { timeout: 3000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export interface CursorTabsDeps {
  /** Absolute path to the workspace state.vscdb, or null when unavailable
   * (no workspace open, not Cursor, feature disabled). */
  dbPath: () => string | null;
  /** Query runner; injected so tests never spawn processes. */
  query: (dbPath: string) => Promise<string>;
  /** Fired when the focused composerId CHANGES (undefined = none focused). */
  onFocusedComposer: (composerId: string | undefined) => void;
  /** One-shot diagnostics when the tracker disables itself. */
  onDisabled?: (reason: string) => void;
  intervalMs?: number;
}

/**
 * Polls the workspace state database and reports focused-tab changes.
 * Lifecycle mirrors the other controllers: start() begins polling, dispose()
 * stops it. After MAX_CONSECUTIVE_FAILURES straight failures the tracker
 * stops polling for the rest of the session.
 */
export class CursorTabTracker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastComposerId: string | undefined;
  private failures = 0;
  private stopped = false;
  private inFlight = false;

  constructor(private readonly deps: CursorTabsDeps) {}

  start(): void {
    if (this.timer || this.stopped) {
      return;
    }
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.deps.intervalMs ?? POLL_INTERVAL_MS);
  }

  /** Exposed for tests — one poll cycle. */
  async poll(): Promise<void> {
    if (this.stopped || this.inFlight) {
      return;
    }
    const db = this.deps.dbPath();
    if (!db) {
      // Not an error (workspace may not be open yet) — just nothing to do.
      return;
    }
    this.inFlight = true;
    try {
      const raw = await this.deps.query(db);
      this.failures = 0;
      const composerId = parseComposerData(raw.trim());
      if (composerId !== this.lastComposerId) {
        this.lastComposerId = composerId;
        this.deps.onFocusedComposer(composerId);
      }
    } catch (err) {
      this.failures += 1;
      if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
        this.disable(err instanceof Error ? err.message : String(err));
      }
    } finally {
      this.inFlight = false;
    }
  }

  get isDisabled(): boolean {
    return this.stopped;
  }

  private disable(reason: string): void {
    this.stopped = true;
    this.clearTimer();
    this.deps.onDisabled?.(reason);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.stopped = true;
    this.clearTimer();
  }
}
