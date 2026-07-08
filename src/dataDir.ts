// Single source of truth for the local data directory that the promptconduit CLI
// writes to (events.jsonl, events.jsonl.1, extension-update.json, …). Node-only
// (os/path); never imported by the webview bundle.
//
// Defaults to ~/.promptconduit, but honors the PROMPTCONDUIT_DIR env var so tests
// and the screenshot-capture harness can point every PromptConduit surface (Cost,
// Stream, Orchestration Theater, Coaching) at a seeded fixture dir WITHOUT
// overriding $HOME. That distinction matters on macOS: $HOME also anchors Cursor's
// auth profile, so moving it would log Cursor out and re-trigger the login wall —
// exactly what we can't have when capturing clean IDE screenshots.
import * as os from "os";
import * as path from "path";

/** The directory name under $HOME that holds the local logs. */
export const DATA_DIR_NAME = ".promptconduit";

/** Absolute path to the local data dir. PROMPTCONDUIT_DIR wins when set. */
export function dataDir(): string {
  const override = process.env.PROMPTCONDUIT_DIR;
  if (override && override.trim() !== "") {
    return override;
  }
  return path.join(os.homedir(), DATA_DIR_NAME);
}
