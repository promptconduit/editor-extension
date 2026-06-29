// Group a flat envelope history by session and pick the most-recently-active
// one. The local log interleaves every session the CLI ever captured; v1 plays
// back a single session, so we isolate the latest by max captured_at. Pure.
import type { RawEnvelope } from "./envelope";

export function groupBySession(envs: RawEnvelope[]): Map<string, RawEnvelope[]> {
  const m = new Map<string, RawEnvelope[]>();
  for (const e of envs) {
    const id = typeof e.native.session_id === "string" ? e.native.session_id : "";
    const arr = m.get(id);
    if (arr) arr.push(e);
    else m.set(id, [e]);
  }
  return m;
}

/**
 * Return the envelopes of the most-recently-active session (by latest
 * captured_at), preserving their original order. Empty input → [].
 */
export function latestSession(envs: RawEnvelope[]): RawEnvelope[] {
  let best: RawEnvelope[] | undefined;
  let bestT = Number.NEGATIVE_INFINITY;
  for (const arr of groupBySession(envs).values()) {
    let t = Number.NEGATIVE_INFINITY;
    for (const e of arr) {
      const parsed = Date.parse(e.capturedAt);
      if (!Number.isNaN(parsed) && parsed > t) t = parsed;
    }
    if (t > bestT) {
      bestT = t;
      best = arr;
    }
  }
  return best ?? [];
}
