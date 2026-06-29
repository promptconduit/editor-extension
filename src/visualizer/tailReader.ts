// Generic, rotation-safe tail of an append-only file. Reads only appended bytes;
// detects truncation/rotation (size shrank or inode changed) and re-reads from
// the top so it survives events.jsonl rolling over to events.jsonl.1. Watches
// the parent directory (the file may not exist yet, and a dir watch survives the
// inode swap) with a poll-loop safety net for editor/FS combos where fs.watch is
// unreliable.
//
// Extracted behavior-preserving from the original EventsTail so the telemetry
// feed (parse → FeedEvent) and the live orchestration view (parse → RawEnvelope)
// share one battle-tested tail. Node-only.
import * as fs from "fs";
import * as path from "path";

const POLL_INTERVAL_MS = 1000;

export class TailReader<T> {
  private offset = 0;
  private inode = 0;
  private carry = ""; // partial trailing line spanning two reads
  private watcher: fs.FSWatcher | undefined;
  private poll: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly file: string,
    private readonly parse: (line: string) => T | null,
    private readonly onItems: (items: T[]) => void,
  ) {}

  start(): void {
    this.readNew(); // seed with whatever already exists
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

  private watchDir(): void {
    const dir = path.dirname(this.file);
    const base = path.basename(this.file);
    try {
      this.watcher = fs.watch(dir, (_event, filename) => {
        if (!filename || filename === base) {
          this.readNew();
        }
      });
      this.watcher.on("error", () => {
        // Polling keeps us alive; drop the watcher rather than throw.
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      // Directory missing or unwatchable — the poll loop still covers us.
    }
  }

  private readNew(): void {
    if (this.disposed) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
    } catch {
      // File gone (not created yet, or deleted): reset so a fresh file is read
      // from the top once it reappears.
      this.reset();
      return;
    }

    // Rotation/truncation: a smaller size or a new inode means the old offset is
    // meaningless. Re-read from the beginning.
    if (stat.size < this.offset || (this.inode && stat.ino !== this.inode)) {
      this.reset();
    }
    this.inode = stat.ino;
    if (stat.size <= this.offset) return; // nothing appended

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
    // Last element is an incomplete line (no trailing newline yet) — carry it.
    this.carry = lines.pop() ?? "";

    const items: T[] = [];
    for (const line of lines) {
      const item = this.parse(line);
      if (item !== null) items.push(item);
    }
    if (items.length > 0) this.onItems(items);
  }

  private reset(): void {
    this.offset = 0;
    this.inode = 0;
    this.carry = "";
  }
}
