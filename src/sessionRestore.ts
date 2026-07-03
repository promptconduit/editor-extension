import * as path from "path";
import { execFile } from "child_process";
import * as vscode from "vscode";

// Bring interrupted AI coding sessions back to life. When the editor restarts it
// tears down the pty host and kills every `claude` process in a terminal;
// persistent-session buffer-restore repaints the tabs so they look alive, but
// the processes are gone. This module asks the CLI engine (`promptconduit
// sessions --json`) what was recently active, drops anything still running or
// outside this workspace, and reopens each one in a terminal at its exact cwd
// (worktree-aware) running `claude --resume <id>`, re-attaching any extra
// `--add-dir` directories the session worked in.

export type RestoreMode = "auto" | "prompt" | "off";

// Mirror of the CLI's sessions.Session JSON (internal/sessions/sessions.go).
export interface RestorableSession {
  session_id: string;
  tool: string;
  cwd: string;
  repo?: string;
  branch?: string;
  last_prompt?: string;
  last_active: string;
  event_count: number;
  alive: boolean;
  // Directories the session worked in outside its launch dir (cwd) — passed
  // back to `claude --resume` as --add-dir so a session that reached across
  // repos comes back with the same working set.
  add_dirs?: string[];
}

/** Parse `promptconduit sessions --json` output. Tolerant of empty/garbage. */
export function parseSessionsJson(raw: string): RestorableSession[] {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(obj)) {
    return [];
  }
  return obj.filter(
    (s): s is RestorableSession =>
      !!s && typeof s === "object" &&
      typeof (s as RestorableSession).session_id === "string" &&
      typeof (s as RestorableSession).cwd === "string",
  );
}

/** True when cwd equals, or is nested under, any of the given roots. */
export function isUnderAny(cwd: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = path.relative(root, cwd);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

/**
 * Pure selection: which sessions should be restored now. Excludes anything
 * still running, already restored this workspace, or outside the open folders.
 * Returns [] when restore is off or there's no workspace to scope to (we never
 * restore machine-wide from a folderless window).
 */
export function selectToRestore(
  all: RestorableSession[],
  roots: string[],
  restoredIds: ReadonlySet<string>,
  mode: RestoreMode,
): RestorableSession[] {
  if (mode === "off" || roots.length === 0) {
    return [];
  }
  return all.filter(
    (s) =>
      s.session_id &&
      s.cwd &&
      !s.alive &&
      !restoredIds.has(s.session_id) &&
      isUnderAny(s.cwd, roots),
  );
}

/** Quote a path for the terminal iff it needs it (spaces or shell chars). */
function quotePath(p: string): string {
  return /^[\w@%+=:,./~-]+$/.test(p) ? p : `"${p.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * The shell command that reopens a session: `claude --resume <id>`, plus an
 * --add-dir for each directory it worked in outside its launch dir (mirrors
 * the CLI's resumeArgs in cmd/resume.go).
 */
export function resumeCommand(s: RestorableSession): string {
  const parts = ["claude", "--resume", s.session_id];
  for (const dir of s.add_dirs ?? []) {
    if (typeof dir === "string" && dir) {
      parts.push("--add-dir", quotePath(dir));
    }
  }
  return parts.join(" ");
}

/** A short, friendly label for a session (branch + last prompt or dir). */
export function sessionLabel(s: RestorableSession): string {
  const where = s.branch || (s.repo ?? path.basename(s.cwd));
  const what = s.last_prompt ? ` — ${s.last_prompt}` : "";
  return `${where}${what}`;
}

const LEDGER_KEY = "promptconduit.restoredSessions";
const LEDGER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Drop ledger entries older than maxAge so it can't grow without bound. */
export function pruneLedger(
  ledger: Record<string, number>,
  nowMs: number,
  maxAgeMs = LEDGER_MAX_AGE_MS,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, ts] of Object.entries(ledger)) {
    if (typeof ts === "number" && nowMs - ts < maxAgeMs) {
      out[id] = ts;
    }
  }
  return out;
}

// Injection seams so the controller is testable and the impure edges (CLI,
// terminals, storage, clock) are swappable.
export interface RestoreDeps {
  resolveBinary(): string | null;
  runSessions(binary: string, sinceHours: number): Promise<string>;
  createTerminal(session: RestorableSession): void;
  getRoots(): string[];
  getMode(): RestoreMode;
  getSinceHours(): number;
  readLedger(): Record<string, number>;
  writeLedger(ledger: Record<string, number>): Thenable<void>;
  now(): number;
  info(message: string, ...actions: string[]): Thenable<string | undefined>;
  pickSessions(sessions: RestorableSession[]): Thenable<RestorableSession[]>;
  openSettings(): void;
}

// Above this many interrupted sessions, even "auto" mode asks first rather than
// ambushing the user with a wall of terminals (e.g. on the very first launch,
// when nothing has been restored yet and the whole recent history is fair game).
export const MAX_AUTO_RESTORE = 6;

export class SessionRestoreController {
  constructor(private readonly deps: RestoreDeps) {}

  /** Startup path: honour the configured mode (auto restores silently). */
  async runStartup(): Promise<void> {
    const mode = this.deps.getMode();
    if (mode === "off") {
      return;
    }
    const candidates = await this.candidates(mode);
    if (candidates.length === 0) {
      return;
    }
    if (mode === "prompt" || candidates.length > MAX_AUTO_RESTORE) {
      // Explicit prompt mode, or too many to open unprompted — ask, don't ambush.
      await this.promptThenRestore(candidates);
      return;
    }
    // auto
    this.restoreAll(candidates);
    this.notifyRestored(candidates);
  }

  /** Manual command: always let the user choose which to bring back. */
  async runManual(): Promise<void> {
    // Ignore the ledger here so the user can reopen something auto-restore
    // already handled or that they previously dismissed.
    const candidates = await this.candidates("prompt", /*ignoreLedger*/ true);
    if (candidates.length === 0) {
      void this.deps.info("PromptConduit: no interrupted sessions to restore in this workspace.");
      return;
    }
    const picked = await this.deps.pickSessions(candidates);
    this.restoreAll(picked);
    if (picked.length > 0) {
      this.notifyRestored(picked);
    }
  }

  private async candidates(mode: RestoreMode, ignoreLedger = false): Promise<RestorableSession[]> {
    const binary = this.deps.resolveBinary();
    if (!binary) {
      return [];
    }
    let raw: string;
    try {
      raw = await this.deps.runSessions(binary, this.deps.getSinceHours());
    } catch {
      // Older CLI without the `sessions` command, or a transient failure —
      // degrade silently; restore is a bonus, never a hard dependency.
      return [];
    }
    const all = parseSessionsJson(raw);
    const restored = ignoreLedger
      ? new Set<string>()
      : new Set(Object.keys(this.deps.readLedger()));
    return selectToRestore(all, this.deps.getRoots(), restored, mode);
  }

  private restoreAll(sessions: RestorableSession[]): void {
    if (sessions.length === 0) {
      return;
    }
    const ledger = pruneLedger(this.deps.readLedger(), this.deps.now());
    for (const s of sessions) {
      this.deps.createTerminal(s);
      ledger[s.session_id] = this.deps.now();
    }
    void this.deps.writeLedger(ledger);
  }

  private async promptThenRestore(candidates: RestorableSession[]): Promise<void> {
    const n = candidates.length;
    const RESTORE = "Restore all";
    const CHOOSE = "Choose…";
    const choice = await this.deps.info(
      `${n} interrupted Claude Code session${n === 1 ? "" : "s"} from before — reopen ${n === 1 ? "it" : "them"}?`,
      RESTORE,
      CHOOSE,
    );
    if (choice === RESTORE) {
      this.restoreAll(candidates);
      this.notifyRestored(candidates);
    } else if (choice === CHOOSE) {
      const picked = await this.deps.pickSessions(candidates);
      this.restoreAll(picked);
      if (picked.length > 0) {
        this.notifyRestored(picked);
      }
    }
  }

  private notifyRestored(sessions: RestorableSession[]): void {
    const n = sessions.length;
    if (n === 0) {
      return;
    }
    const SETTINGS = "Settings";
    void this.deps
      .info(
        `PromptConduit reopened ${n} interrupted Claude Code session${n === 1 ? "" : "s"}.`,
        SETTINGS,
      )
      .then((choice) => {
        if (choice === SETTINGS) {
          this.deps.openSettings();
        }
      });
  }
}

// --- Real dependency wiring (kept out of the testable core above) -----------

const RESTORED_STATE_KEY = LEDGER_KEY;

/** execFile the CLI's `sessions --json`, returning stdout. Rejects on failure. */
export function runSessionsCommand(binary: string, sinceHours: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ["sessions", "--json", "--since", `${sinceHours}h`],
      { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
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

export function makeRestoreDeps(
  context: vscode.ExtensionContext,
  resolveBinary: () => string | null,
): RestoreDeps {
  const cfg = () => vscode.workspace.getConfiguration("promptconduit.restore");
  return {
    resolveBinary,
    runSessions: runSessionsCommand,
    createTerminal: (s) => {
      const term = vscode.window.createTerminal({
        name: `claude · ${s.branch || path.basename(s.cwd)}`,
        cwd: s.cwd,
        iconPath: new vscode.ThemeIcon("comment-discussion"),
      });
      // sendText runs the command whether or not the terminal is focused, so we
      // don't steal focus by showing each one — the summary toast tells the user.
      term.sendText(resumeCommand(s));
    },
    getRoots: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    getMode: () => cfg().get<RestoreMode>("mode", "auto"),
    getSinceHours: () => cfg().get<number>("sinceHours", 12),
    readLedger: () => context.workspaceState.get<Record<string, number>>(RESTORED_STATE_KEY, {}),
    writeLedger: (ledger) => context.workspaceState.update(RESTORED_STATE_KEY, ledger),
    now: () => Date.now(),
    info: (message, ...actions) => vscode.window.showInformationMessage(message, ...actions),
    pickSessions: async (sessions) => {
      const picks = await vscode.window.showQuickPick(
        sessions.map((s) => ({
          label: `$(comment-discussion) ${s.branch || path.basename(s.cwd)}`,
          description: s.last_prompt ?? "",
          detail: s.cwd,
          session: s,
          picked: true,
        })),
        { canPickMany: true, title: "Reopen interrupted Claude Code sessions" },
      );
      return (picks ?? []).map((p) => p.session);
    },
    openSettings: () =>
      void vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "promptconduit.restore",
      ),
  };
}
