// Full-history reader for cinematic playback: reads the rotated events.jsonl.1
// (older) before events.jsonl (newer) so the result is chronological, tolerant
// of malformed lines, and honors the CLI's disable switch. Node-only.
import * as fs from "fs";
import { eventsJsonlPath, rotatedEventsPath, logDisabled } from "./paths";
import { parseEnvelope, RawEnvelope } from "./envelope";

function readLines(file: string): RawEnvelope[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return []; // absent/unreadable file is a normal empty case
  }
  const out: RawEnvelope[] = [];
  for (const line of text.split("\n")) {
    const env = parseEnvelope(line);
    if (env) out.push(env);
  }
  return out;
}

/**
 * Read the full local history in chronological order: the rotated backup first
 * (older events) then the live file. Returns [] when the log is disabled or
 * absent. `home` is injectable for tests.
 */
export function readHistory(home?: string): RawEnvelope[] {
  if (logDisabled()) return [];
  return [...readLines(rotatedEventsPath(home)), ...readLines(eventsJsonlPath(home))];
}
