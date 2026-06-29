import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Raw line tail of the local event log. Unlike eventsFeed.ts's EventsTail (which
// only ever keeps the last ~200 lines for the live telemetry feed), this reads a
// BOUNDED FULL HISTORY once on startup so the coaching tab can build real trends
// offline, then tails appended bytes for live updates. It emits raw JSONL lines;
// the caller parses them (coaching/derive.ts). Rotation/truncation safe.

const EVENTS_DIR = ".promptconduit";
const EVENTS_FILE = "events.jsonl";
const ROTATED_FILE = "events.jsonl.1";

// Cap the initial history read so a large log never blocks the UI. ~24MB of
// JSONL is tens of thousands of events — far more than needed for trends, and we
// always read the NEWEST bytes (the tail of the file).
const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;
const POLL_INTERVAL_MS = 1000;

export function eventsJsonlPath(): string {
  return path.join(os.homedir(), EVENTS_DIR, EVENTS_FILE);
}
export function rotatedJsonlPath(): string {
  return path.join(os.homedir(), EVENTS_DIR, ROTATED_FILE);
}

/** True when the user disabled the local event log via the CLI's env switch. */
export function logDisabled(): boolean {
  return process.env.PROMPTCONDUIT_EVENT_LOG === "0";
}

// Read up to `maxBytes` from the END of a file and return complete lines. Drops a
// leading partial line so we never hand back a truncated JSON fragment.
function readTailLines(file: string, maxBytes: number): string[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  if (stat.size === 0) {
    return [];
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
    return [];
  }
  const lines = text.split("\n");
  // If we started mid-file, the first element is a partial line — drop it.
  if (start > 0 && lines.length > 0) {
    lines.shift();
  }
  return lines.filter((l) => l.trim().length > 0);
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
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(this.file);
    } catch {
      stat = undefined;
    }

    const currentLines = stat ? readTailLines(this.file, this.maxBytes) : [];
    const budgetLeft = this.maxBytes - (stat ? Math.min(stat.size, this.maxBytes) : 0);
    const rotatedLines = budgetLeft > 64 * 1024 ? readTailLines(rotatedJsonlPath(), budgetLeft) : [];
    const lines = [...rotatedLines, ...currentLines];

    if (stat) {
      this.offset = stat.size;
      this.inode = stat.ino;
    }
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
