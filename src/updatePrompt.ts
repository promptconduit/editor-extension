import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

// After the promptconduit CLI updates this extension on disk (post-upgrade
// reconcile), the copy running in the current window is stale until a reload.
// The CLI drops a marker at ~/.promptconduit/extension-update.json; we watch it
// and, when it names a version NEWER than the one we're running, offer a
// one-click **Reload Window**. Reload — not restart — so the pty host survives
// and terminals running Claude Code keep their sessions.

const MARKER_DIR = ".promptconduit";
const MARKER_FILE = "extension-update.json";

export function markerPath(): string {
  return path.join(os.homedir(), MARKER_DIR, MARKER_FILE);
}

// Mirror of the CLI's extension.UpdateMarker (internal/extension/marker.go).
// Keep the field names in sync.
export interface UpdateMarker {
  version: string;
  editor?: string;
  updated_at?: string;
}

/** Parse the marker JSON. Returns null for anything without a usable version. */
export function parseUpdateMarker(raw: string): UpdateMarker | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") {
    return null;
  }
  const version = (obj as Record<string, unknown>).version;
  if (typeof version !== "string" || version.trim() === "") {
    return null;
  }
  const editor = (obj as Record<string, unknown>).editor;
  const updatedAt = (obj as Record<string, unknown>).updated_at;
  return {
    version: version.trim(),
    editor: typeof editor === "string" ? editor : undefined,
    updated_at: typeof updatedAt === "string" ? updatedAt : undefined,
  };
}

// Compare plain MAJOR.MINOR.PATCH versions. Returns true only when `candidate`
// is strictly greater. Conservative: any non-numeric/short version yields false,
// so a malformed marker never triggers a spurious reload prompt. This mirrors
// the CLI's updater.IsNewerVersion so both ends agree on "newer".
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const parts = v.trim().split(".");
    if (parts.length !== 3) {
      return null;
    }
    const nums = parts.map((p) => Number(p));
    if (nums.some((n) => !Number.isInteger(n) || n < 0)) {
      return null;
    }
    return [nums[0], nums[1], nums[2]];
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) {
    return false;
  }
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] > b[i];
    }
  }
  return false;
}

/**
 * Pure decision: should we prompt the user to reload? Only when the marker names
 * a version strictly newer than the one we're running. Equal (already applied)
 * or older (a downgrade) → no prompt.
 */
export function shouldPromptReload(runningVersion: string, marker: UpdateMarker | null): boolean {
  if (!marker) {
    return false;
  }
  return isNewerVersion(marker.version, runningVersion);
}

/**
 * Pure dedupe decision used by the controller: returns the version to prompt for
 * now, or null. Null when there's nothing newer to apply OR we've already
 * offered exactly this version this session (so we never nag). This is where the
 * "prompt at most once per version" rule lives — kept pure so it's testable
 * without the editor.
 */
export function nextPromptVersion(
  runningVersion: string,
  marker: UpdateMarker | null,
  alreadyPromptedVersion: string | undefined,
): string | null {
  if (!shouldPromptReload(runningVersion, marker) || !marker) {
    return null;
  }
  if (marker.version === alreadyPromptedVersion) {
    return null;
  }
  return marker.version;
}

const RELOAD = "Reload Window";
const LATER = "Later";

/**
 * Watches the update marker and, when a newer version lands, shows a
 * non-blocking toast offering a one-click reload. Re-checks on file change and
 * when the window regains focus, but prompts at most once per marker version per
 * session so it never nags.
 */
export class UpdatePromptController implements vscode.Disposable {
  private watcher: fs.FSWatcher | undefined;
  private disposables: vscode.Disposable[] = [];
  private promptedVersion: string | undefined;
  private disposed = false;

  constructor(
    private readonly runningVersion: string,
    // Injectable for tests; defaults to the real reload command.
    private readonly reload: () => void = () =>
      void vscode.commands.executeCommand("workbench.action.reloadWindow"),
    private readonly showMessage: (
      message: string,
      ...items: string[]
    ) => Thenable<string | undefined> = (m, ...items) =>
      vscode.window.showInformationMessage(m, ...items),
  ) {}

  start(): void {
    // Re-check when the window regains focus (an update may have landed while
    // the user was away in another app or window).
    this.disposables.push(
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) {
          this.check();
        }
      }),
    );
    this.watchMarker();
    this.check();
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    this.watcher = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private watchMarker(): void {
    const dir = path.dirname(markerPath());
    const base = path.basename(markerPath());
    try {
      // Watch the directory (the file may not exist yet) and react to changes
      // to the marker itself.
      this.watcher = fs.watch(dir, (_event, filename) => {
        if (!filename || filename === base) {
          this.check();
        }
      });
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      // Directory doesn't exist yet / watch unsupported — the focus re-check
      // still covers us.
    }
  }

  private check(): void {
    if (this.disposed) {
      return;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(markerPath(), "utf8");
    } catch {
      return; // no marker yet
    }
    const marker = parseUpdateMarker(raw);
    const version = nextPromptVersion(this.runningVersion, marker, this.promptedVersion);
    if (!version) {
      return;
    }
    this.promptedVersion = version;
    void this.showMessage(
      `PromptConduit updated to v${version} — reload to apply.`,
      RELOAD,
      LATER,
    ).then((choice) => {
      if (choice === RELOAD) {
        this.reload();
      }
    });
  }
}
