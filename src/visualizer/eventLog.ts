// Recent-history reader for cinematic playback: reads the newest bytes of the
// rotated events.jsonl.1 (older) before events.jsonl (newer) so the result is
// chronological, tolerant of malformed lines, and honors the CLI's disable
// switch. Bounded: the live log can be hundreds of MB, and playback only needs
// the latest session, so at most `maxBytes` are read (newest first, topped up
// from the rotation) in sliced reads. Node-only.
import { readTailLines } from "../boundedTail";
import { eventsJsonlPath, rotatedEventsPath, logDisabled } from "./paths";
import { parseEnvelope, RawEnvelope } from "./envelope";

export const HISTORY_MAX_BYTES = 16 * 1024 * 1024;

function parseLines(lines: string[], out: RawEnvelope[]): void {
  for (const line of lines) {
    const env = parseEnvelope(line);
    if (env) out.push(env);
  }
}

/**
 * Read recent local history in chronological order: the rotated backup first
 * (older events) then the live file, newest `maxBytes` overall. Returns [] when
 * the log is disabled or absent. `home` is injectable for tests.
 */
export function readHistory(home?: string, maxBytes = HISTORY_MAX_BYTES): RawEnvelope[] {
  if (logDisabled()) return [];
  const current = readTailLines(eventsJsonlPath(home), maxBytes);
  const budgetLeft = maxBytes - Math.min(current.size, maxBytes);
  const rotated = budgetLeft > 0 ? readTailLines(rotatedEventsPath(home), budgetLeft) : undefined;
  const out: RawEnvelope[] = [];
  if (rotated) {
    parseLines(rotated.lines, out);
    // The rotation is complete; a trailing line without a newline still counts.
    parseLines([rotated.carry], out);
  }
  parseLines(current.lines, out);
  parseLines([current.carry], out);
  return out;
}
