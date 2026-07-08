import * as fs from "fs";
import * as path from "path";
import { dataDir } from "./dataDir";

// Raw line tail of the local event log. Unlike the per-panel TailReader (which
// only ever keeps the last ~200 lines for the live telemetry feed), this reads a
// BOUNDED FULL HISTORY once on startup so the coaching tab can build real trends
// offline, then tails appended bytes for live updates. It emits raw JSONL lines;
// the caller parses them (coaching/derive.ts). Rotation/truncation safe.

const EVENTS_FILE = "events.jsonl";
const ROTATED_FILE = "events.jsonl.1";

// Cap the initial history read so a large log never blocks the UI. ~24MB of
// JSONL is tens of thousands of events — far more than needed for trends, and we
// always read the NEWEST bytes (the tail of the file).
const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;
const POLL_INTERVAL_MS = 1000;

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

interface TailRead {
  lines: string[];
  carry: string; // trailing partial line (no newline yet), held back from `lines`
  size: number; // the stat.size the read covered — use this for the live offset
  inode: number;
}

// Read up to `maxBytes` from the END of a file using a SINGLE stat (so the
// returned `size` exactly matches the bytes covered — the caller sets its live
// offset from it, avoiding a re-read/double-count window). Drops a leading
// partial line, and holds back a trailing partial line as `carry` so a
// mid-write final event isn't emitted as a broken fragment.
function readTailLines(file: string, maxBytes: number): TailRead {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { lines: [], carry: "", size: 0, inode: 0 };
  }
  if (stat.size === 0) {
    return { lines: [], carry: "", size: 0, inode: stat.ino };
  }
  const start = stat.size > maxBytes ? stat.size - maxBytes : 0;
  const len = stat.size - start;
  let text: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.allocUnsafe(len);
      const read = fs.readSync(fd, buf, 0, len, start);
      text = buf.toString("utf8", 0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { lines: [], carry: "", size: 0, inode: stat.ino };
  }
  const parts = text.split("\n");
  // If we started mid-file, the first element is a leading partial line — drop it.
  if (start > 0 && parts.length > 0) {
    parts.shift();
  }
  // The last element is "" when the file ended in a newline, or the in-progress
  // final line otherwise — hold it as carry rather than emitting it.
  const carry = parts.pop() ?? "";
  return { lines: parts.filter((l) => l.trim().length > 0), carry, size: stat.size, inode: stat.ino };
}

export interface RawTailOptions {
  /** Receives raw JSONL lines. `initial` is true for the one-shot history read. */
  onLines: (lines: string[], initial: boolean) => void;
  file?: string;
  maxBytes?: number;
}

export class RawEventTail {
  private readonly file: string;
  private readonly maxBytes: number;
  private offset = 0;
  private inode = 0;
  private carry = "";
  private watcher: fs.FSWatcher | undefined;
  private poll: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly opts: RawTailOptions) {
    this.file = opts.file ?? eventsJsonlPath();
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  start(): void {
    this.initialRead();
    this.watchDir();
    this.poll = setInterval(() => this.readNew(), POLL_INTERVAL_MS);
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
  }

  // One-shot bounded history: newest bytes of events.jsonl, topped up from the
  // rotated events.jsonl.1 if there's budget left. Then position the tail at the
  // current end of events.jsonl so live appends flow in without re-reading.
  private initialRead(): void {
    // Current file: one stat covers both the read and the live offset/carry, so
    // appends during startup are picked up exactly once by readNew (no overlap).
    const current = readTailLines(this.file, this.maxBytes);
    const budgetLeft = this.maxBytes - Math.min(current.size, this.maxBytes);
    // Rotated file is complete history; fold any trailing fragment in as a line.
    const rotated = budgetLeft > 64 * 1024
      ? readTailLines(rotatedJsonlPath(), budgetLeft)
      : { lines: [], carry: "", size: 0, inode: 0 };
    const rotatedLines = rotated.carry.trim() ? [...rotated.lines, rotated.carry] : rotated.lines;
    const lines = [...rotatedLines, ...current.lines];

    this.offset = current.size;
    this.inode = current.inode;
    this.carry = current.carry;

    if (lines.length > 0) {
      this.opts.onLines(lines, true);
    } else {
      // Still signal an (empty) initial read so the UI can paint a zero-state.
      this.opts.onLines([], true);
    }
  }

  private watchDir(): void {
    const dir = path.dirname(this.file);
    const base = path.basename(this.file);
    try {
      this.watcher = fs.watch(dir, (_e, filename) => {
        if (!filename || filename === base) {
          this.readNew();
        }
      });
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      // Polling covers us.
    }
  }

  private readNew(): void {
    if (this.disposed) {
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
    } catch {
      this.reset();
      return;
    }
    if (stat.size < this.offset || (this.inode && stat.ino !== this.inode)) {
      // Rotation/truncation: re-read from the top of the new file.
      this.offset = 0;
      this.carry = "";
    }
    this.inode = stat.ino;
    if (stat.size <= this.offset) {
      return;
    }

    let chunk: string;
    try {
      const fd = fs.openSync(this.file, "r");
      try {
        const len = stat.size - this.offset;
        const buf = Buffer.allocUnsafe(len);
        const read = fs.readSync(fd, buf, 0, len, this.offset);
        chunk = buf.toString("utf8", 0, read);
        this.offset += read;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }

    const text = this.carry + chunk;
    const lines = text.split("\n");
    this.carry = lines.pop() ?? "";
    const complete = lines.filter((l) => l.trim().length > 0);
    if (complete.length > 0) {
      this.opts.onLines(complete, false);
    }
  }

  private reset(): void {
    this.offset = 0;
    this.inode = 0;
    this.carry = "";
  }
}
