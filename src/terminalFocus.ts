import { execFile } from "child_process";
import * as vscode from "vscode";

export interface ResolveCandidate {
  session_id: string;
  pid?: string;
  cwd?: string;
}

export interface ResolveResult {
  session_id?: string;
  tool?: string;
  cwd?: string;
  ambiguous?: boolean;
  candidates?: ResolveCandidate[];
}

/** Parse `promptconduit sessions resolve --pid … --json` output. */
export function parseResolveJson(raw: string): ResolveResult {
  try {
    const obj = JSON.parse(raw) as ResolveResult;
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

/** execFile the CLI's `sessions resolve --pid`, returning stdout. */
export function runResolveCommand(binary: string, shellPid: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ["sessions", "resolve", "--pid", String(shellPid), "--json"],
      { timeout: 5000, maxBuffer: 256 * 1024 },
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

export interface TerminalFocusDeps {
  resolveBinary: () => string | null;
  runResolve: (binary: string, shellPid: number) => Promise<string>;
  pickCandidate: (candidates: ResolveCandidate[]) => Promise<string | undefined>;
  onFocusChange: (sessionKey: string | undefined, source: "terminal" | "activity") => void;
}

/**
 * TerminalFocusController maps the focused VS Code terminal's shell PID to a
 * Claude Code session via the CLI resolver. Restored terminals can be cached
 * by session id when process inspection is slow or unavailable.
 */
export class TerminalFocusController {
  private readonly terminalCache = new Map<vscode.Terminal, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private focusedSessionKey: string | undefined;

  constructor(private readonly deps: TerminalFocusDeps) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTerminal((term) => {
        void this.resolveTerminal(term);
      }),
      vscode.window.onDidCloseTerminal((term) => {
        this.terminalCache.delete(term);
      }),
    );
    void this.resolveTerminal(vscode.window.activeTerminal);
  }

  get sessionKey(): string | undefined {
    return this.focusedSessionKey;
  }

  /** Belt-and-suspenders cache for terminals opened via session restore. */
  registerTerminal(terminal: vscode.Terminal, sessionId: string): void {
    this.terminalCache.set(terminal, sessionId);
    if (vscode.window.activeTerminal === terminal) {
      this.setFocus(sessionId);
    }
  }

  private setFocus(sessionKey: string | undefined): void {
    this.focusedSessionKey = sessionKey;
    this.deps.onFocusChange(sessionKey, sessionKey ? "terminal" : "activity");
  }

  private async resolveTerminal(term: vscode.Terminal | undefined): Promise<void> {
    if (!term) {
      this.setFocus(undefined);
      return;
    }

    const cached = this.terminalCache.get(term);
    if (cached) {
      this.setFocus(cached);
      return;
    }

    let shellPid: number | undefined;
    try {
      shellPid = await term.processId;
    } catch {
      shellPid = undefined;
    }
    if (!shellPid) {
      this.setFocus(undefined);
      return;
    }

    const binary = this.deps.resolveBinary();
    if (!binary) {
      this.setFocus(undefined);
      return;
    }

    try {
      const raw = await this.deps.runResolve(binary, shellPid);
      const result = parseResolveJson(raw);
      if (result.ambiguous && result.candidates && result.candidates.length > 0) {
        const picked = await this.deps.pickCandidate(result.candidates);
        if (picked) {
          this.terminalCache.set(term, picked);
          this.setFocus(picked);
        } else {
          this.setFocus(undefined);
        }
        return;
      }
      if (result.session_id) {
        this.terminalCache.set(term, result.session_id);
        this.setFocus(result.session_id);
        return;
      }
    } catch {
      // Best-effort — fall back to activity-based selection.
    }
    this.setFocus(undefined);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

export function makeTerminalFocusDeps(
  resolveBinary: () => string | null,
  onFocusChange: (sessionKey: string | undefined, source: "terminal" | "activity") => void,
): TerminalFocusDeps {
  return {
    resolveBinary,
    runResolve: runResolveCommand,
    onFocusChange,
    pickCandidate: async (candidates) => {
      const pick = await vscode.window.showQuickPick(
        candidates.map((c) => ({
          label: c.session_id.length > 12 ? `…${c.session_id.slice(-8)}` : c.session_id,
          description: c.cwd ?? "",
          detail: c.pid ? `pid ${c.pid}` : undefined,
          session_id: c.session_id,
        })),
        { placeHolder: "Several Claude sessions in this terminal — which one?" },
      );
      return pick?.session_id;
    },
  };
}
