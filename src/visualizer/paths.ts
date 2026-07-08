// Resolution of the local event-log paths. Node-only (path); never imported by
// the webview bundle. Mirrors cli/internal/eventlog: the CLI writes one envelope
// per line to ~/.promptconduit/events.jsonl, rotating to events.jsonl.1 at ~50MB.
import * as path from "path";
import { dataDir, DATA_DIR_NAME } from "../dataDir";

export const EVENTS_DIR = DATA_DIR_NAME;
export const EVENTS_FILE = "events.jsonl";
export const ROTATED_FILE = "events.jsonl.1";

/**
 * The directory holding the local logs. With no argument it resolves the real
 * data dir (honoring PROMPTCONDUIT_DIR, see ../dataDir). Pass an explicit `home`
 * to derive `<home>/.promptconduit` — kept for tests that inject a fake home.
 */
export function eventsDir(home?: string): string {
  return home !== undefined ? path.join(home, EVENTS_DIR) : dataDir();
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
