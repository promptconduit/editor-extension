import * as path from "path";
import { dataDir } from "./dataDir";
import { LineTail, readTailLines, SliceOptions } from "./boundedTail";

// Raw line tail of the local event log. Unlike the per-panel TailReader (which
// only ever keeps the last ~200 lines for the live telemetry feed), this reads a
// BOUNDED FULL HISTORY once on startup so the coaching tab can build real trends
// offline, then tails appended bytes for live updates. It emits raw JSONL lines;
// the caller parses them (coaching/derive.ts). Rotation/truncation safe, and
// every read is bounded and sliced (see boundedTail.ts).

const EVENTS_FILE = "events.jsonl";
const ROTATED_FILE = "events.jsonl.1";

// Cap the initial history read so a large log never blocks the UI. ~24MB of
// JSONL is tens of thousands of events — far more than needed for trends, and we
// always read the NEWEST bytes (the tail of the file).
const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;
const POLL_INTERVAL_MS = 1000;
// After a rotation or a prune rewrite only the newest bytes are re-read (and
// already-seen lines skipped); the full history was ingested at startup.
const DEFAULT_RESEED_BYTES = 8 * 1024 * 1024;

export function eventsJsonlPath(): string {
  return path.join(dataDir(), EVENTS_FILE);
}
export function rotatedJsonlPath(): string {
  return path.join(dataDir(), ROTATED_FILE);
}

/** True when the user disabled the local event log via the CLI's env switch. */
export function logDisabled(): boolean {
  return process.env.PROMPTCONDUIT_EVENT_LOG === "0";
}

export interface RawTailOptions extends SliceOptions {
  /** Receives raw JSONL lines. `initial` is true for the one-shot history read. */
  onLines: (lines: string[], initial: boolean) => void;
  file?: string;
  /** Initial history budget (newest bytes of events.jsonl, topped up from .1). */
  maxBytes?: number;
  /** Re-read budget after rotation/truncation/a rewrite. */
  reseedBytes?: number;
  pollMs?: number;
}

export class RawEventTail {
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly tail: LineTail;

  constructor(private readonly opts: RawTailOptions) {
    this.file = opts.file ?? eventsJsonlPath();
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.tail = new LineTail({
      file: this.file,
      seedBytes: this.maxBytes,
      reseedBytes: opts.reseedBytes ?? Math.min(this.maxBytes, DEFAULT_RESEED_BYTES),
      sliceBytes: opts.sliceBytes,
      maxLineChars: opts.maxLineChars,
      readSync: opts.readSync,
      pollMs: opts.pollMs ?? POLL_INTERVAL_MS,
      onLines: (lines) => this.opts.onLines(lines, false),
    });
  }

  start(): void {
    this.initialRead();
    this.tail.startWatching();
  }

  /** Poll once now (tests; the watcher/poll loop calls this in production). */
  tick(): void {
    this.tail.readNew();
  }

  dispose(): void {
    this.tail.dispose();
  }

  // One-shot bounded history: newest bytes of events.jsonl, topped up from the
  // rotated events.jsonl.1 if there's budget left. The live tail is positioned
  // at the end of what it read, so appends during startup flow in exactly once.
  private initialRead(): void {
    const current = this.tail.readInitial();
    const size = this.tail.offset; // bytes of events.jsonl covered (0 when absent)
    const budgetLeft = this.maxBytes - Math.min(size, this.maxBytes);
    // Rotated file is complete history; fold any trailing fragment in as a line.
    const rotated = budgetLeft > 64 * 1024 ? readTailLines(this.rotatedFile(), budgetLeft, this.opts) : undefined;
    const rotatedLines = rotated
      ? rotated.carry.trim()
        ? [...rotated.lines, rotated.carry]
        : rotated.lines
      : [];
    // Always signal the initial read (possibly empty) so the UI can paint.
    this.opts.onLines([...rotatedLines, ...current], true);
  }

  private rotatedFile(): string {
    return this.opts.file ? `${this.opts.file}.1` : rotatedJsonlPath();
  }
}
