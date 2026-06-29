// Resolution of the local event-log paths. Node-only (fs/os/path); never
// imported by the webview bundle. Mirrors cli/internal/eventlog: the CLI writes
// one envelope per line to ~/.promptconduit/events.jsonl, rotating to
// events.jsonl.1 at ~50MB.
import * as os from "os";
import * as path from "path";

export const EVENTS_DIR = ".promptconduit";
export const EVENTS_FILE = "events.jsonl";
export const ROTATED_FILE = "events.jsonl.1";

/** The directory holding the local logs (~/.promptconduit). Injectable for tests. */
export function eventsDir(home: string = os.homedir()): string {
  return path.join(home, EVENTS_DIR);
}

export function eventsJsonlPath(home?: string): string {
  return path.join(eventsDir(home), EVENTS_FILE);
}

export function rotatedEventsPath(home?: string): string {
  return path.join(eventsDir(home), ROTATED_FILE);
}

/** True when the user disabled the local event log via the CLI's env switch. */
export function logDisabled(): boolean {
  return process.env.PROMPTCONDUIT_EVENT_LOG === "0";
}
