// Bounded, rotation-safe line tail of an append-only JSONL file. Node-only.
//
// The local event log can grow to hundreds of MB (many concurrent agents, no
// size rotation between prunes), so nothing here allocates a buffer or string
// proportional to the file size:
//   - the initial read covers only the newest `seedBytes`;
//   - every read is split into slices of at most `sliceBytes`, decoded with a
//     StringDecoder (multi-byte characters may straddle a slice boundary), and
//     the offset advances per slice, so a failure part-way never rewinds or
//     wedges the tail;
//   - on rotation / truncation / a rewrite (new inode) it re-reads only the
//     newest `reseedBytes` of the new file, and skips lines up to the last one
//     it already emitted so a pruned rewrite is not ingested twice;
//   - a single "line" longer than `maxLineChars` (a corrupt or non-JSONL file)
//     is dropped rather than buffered forever.
// Starting mid-file, the first partial line is dropped.

import * as fs from "fs";
import * as path from "path";
import { StringDecoder } from "string_decoder";

export const DEFAULT_SLICE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_LINE_CHARS = 16 * 1024 * 1024;
const DEFAULT_POLL_MS = 1000;

type ReadSync = (fd: number, buf: Buffer, off: number, len: number, pos: number) => number;

export interface SliceOptions {
  /** Max bytes per read call (and per decoded string). */
  sliceBytes?: number;
  /** Lines longer than this are dropped instead of carried. */
  maxLineChars?: number;
  /** Injectable for tests (e.g. to assert slice sizes or simulate a failed read). */
  readSync?: ReadSync;
}

/**
 * Splits decoded text into complete lines, carrying the trailing partial line
 * between pushes. Optionally discards everything up to the first newline (used
 * when a read starts mid-line).
 */
export class LineSplitter {
  carry = "";
  constructor(
    private skipping: boolean,
    private readonly maxLineChars = DEFAULT_MAX_LINE_CHARS,
  ) {}

  push(text: string): string[] {
    let s = this.carry.length > 0 ? this.carry + text : text;
    this.carry = "";
    if (this.skipping) {
      const nl = s.indexOf("\n");
      if (nl < 0) {
        return [];
      }
      s = s.slice(nl + 1);
      this.skipping = false;
    }
    const parts = s.split("\n");
    const tail = parts.pop() ?? "";
    if (tail.length > this.maxLineChars) {
      // Oversized fragment: drop it and resync at the next newline.
      this.skipping = true;
    } else {
      this.carry = tail;
    }
    return parts.filter((l) => l.trim().length > 0);
  }
}

/** A positioned reader over one file: offset + decoder + splitter. */
class Cursor {
  offset: number;
  private decoder = new StringDecoder("utf8");
  readonly splitter: LineSplitter;

  // When starting mid-file, begin one byte early: if that byte is "\n" the
  // first line is complete and only the newline is discarded.
  constructor(start: number, maxLineChars: number) {
    this.offset = start > 0 ? start - 1 : 0;
    this.splitter = new LineSplitter(start > 0, maxLineChars);
  }

  /**
   * Read [offset, end) in slices, handing each slice's complete lines to `sink`.
   * The offset advances after every successful slice. Errors stop the drain and
   * are swallowed (the next call resumes from the last good slice).
   */
  drain(file: string, end: number, opts: SliceOptions, sink: (lines: string[]) => void): void {
    if (end <= this.offset) {
      return;
    }
    const slice = Math.max(1, opts.sliceBytes ?? DEFAULT_SLICE_BYTES);
    const readSync: ReadSync = opts.readSync ?? fs.readSync;
    let fd: number;
    try {
      fd = fs.openSync(file, "r");
    } catch {
      return;
    }
    try {
      const buf = Buffer.allocUnsafe(Math.min(slice, end - this.offset));
      while (this.offset < end) {
        const len = Math.min(buf.length, end - this.offset);
        const read = readSync(fd, buf, 0, len, this.offset);
        if (read <= 0) {
          break;
        }
        this.offset += read;
        const lines = this.splitter.push(this.decoder.write(buf.subarray(0, read)));
        if (lines.length > 0) {
          sink(lines);
        }
      }
    } catch {
      // Keep whatever offset we reached.
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

export interface TailRead {
  lines: string[];
  /** Trailing partial line (no newline yet), held back from `lines`. */
  carry: string;
  /** The stat.size the read covered. */
  size: number;
  inode: number;
}

/**
 * Read the newest `maxBytes` of a file as complete lines using a single stat
 * (so `size` exactly matches the bytes covered). Sliced; never allocates more
 * than one slice at a time.
 */
export function readTailLines(file: string, maxBytes: number, opts: SliceOptions = {}): TailRead {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { lines: [], carry: "", size: 0, inode: 0 };
  }
  const start = stat.size > maxBytes ? stat.size - maxBytes : 0;
  const cur = new Cursor(start, opts.maxLineChars ?? DEFAULT_MAX_LINE_CHARS);
  const lines: string[] = [];
  cur.drain(file, stat.size, opts, (ls) => {
    for (const l of ls) lines.push(l);
  });
  return { lines, carry: cur.splitter.carry, size: stat.size, inode: stat.ino };
}

export interface LineTailOptions extends SliceOptions {
  file: string;
  /** Live lines (appends, and the deduplicated re-read after a rotation). */
  onLines: (lines: string[]) => void;
  /** Bytes read from the end of the file by readInitial(). */
  seedBytes: number;
  /** Bytes re-read from the end after rotation/truncation/a large gap. Defaults to seedBytes. */
  reseedBytes?: number;
  /**
   * Where the file is renamed to on rotation (default `${file}.1`). When the
   * live file's inode changes and this path holds the old inode, the bytes
   * appended before the rename are drained from it first (bounded).
   */
  rotatedFile?: string;
  pollMs?: number;
}

export class LineTail {
  private cursor: Cursor | undefined; // undefined = not positioned (file absent)
  private inode = 0;
  private lastLine: string | undefined;
  // Dedup after a reseed: lines are held back until `lastLine` is found (emit
  // only what follows it) or the reseed window [.., skipEnd) is fully read
  // without finding it (then everything held is new). Persists across polls,
  // so a reseed read that stops part-way can't re-emit already-seen lines.
  private skipping = false;
  private skipEnd = 0;
  private skipBuf: string[] = [];
  private watcher: fs.FSWatcher | undefined;
  private poll: NodeJS.Timeout | undefined;
  private disposed = false;
  private readonly reseedBytes: number;

  constructor(private readonly opts: LineTailOptions) {
    this.reseedBytes = opts.reseedBytes ?? opts.seedBytes;
  }

  /** Current read offset (tests). */
  get offset(): number {
    return this.cursor?.offset ?? 0;
  }

  /**
   * Read the newest `seedBytes` and position the tail at the end of what was
   * read. Returns the lines rather than emitting them.
   */
  readInitial(): string[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.opts.file);
    } catch {
      return [];
    }
    const lines: string[] = [];
    this.position(stat, this.opts.seedBytes);
    this.cursor!.drain(this.opts.file, stat.size, this.opts, (ls) => {
      for (const l of ls) lines.push(l);
    });
    this.noteEmitted(lines);
    return lines;
  }

  startWatching(): void {
    const dir = path.dirname(this.opts.file);
    const base = path.basename(this.opts.file);
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
      // Directory missing or unwatchable — the poll loop covers us.
    }
    this.poll = setInterval(() => this.readNew(), this.opts.pollMs ?? DEFAULT_POLL_MS);
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

  /** Read whatever was appended (or re-seed after a rotation). Public for tests. */
  readNew(): void {
    if (this.disposed) {
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.opts.file);
    } catch {
      // Gone (deleted, or mid-rename). Keep the cursor and inode: when the file
      // reappears with a new inode, the rotated copy can still be drained.
      return;
    }
    const cur = this.cursor;
    const rotated = cur !== undefined && this.inode !== 0 && stat.ino !== this.inode;
    if (rotated) {
      this.drainRotated(cur);
    }
    const reseed =
      !cur ||
      rotated ||
      stat.size < cur.offset ||
      stat.size - cur.offset > this.reseedBytes;
    if (reseed) {
      this.position(stat, this.reseedBytes);
      this.skipBuf = [];
      this.skipping = this.lastLine !== undefined;
      this.skipEnd = stat.size;
    }
    this.inode = stat.ino;
    this.cursor!.drain(this.opts.file, stat.size, this.opts, (lines) => this.accept(lines));
    this.settleSkip();
  }

  // The live file was renamed away (rotation). If the rotated path still holds
  // the inode we were reading, finish it from our offset (bounded by the reseed
  // budget), including a final line that never got its newline.
  private drainRotated(cur: Cursor): void {
    const rotatedFile = this.opts.rotatedFile ?? `${this.opts.file}.1`;
    let rstat: fs.Stats;
    try {
      rstat = fs.statSync(rotatedFile);
    } catch {
      return;
    }
    if (rstat.ino !== this.inode || rstat.size < cur.offset) {
      return;
    }
    const end = Math.min(rstat.size, cur.offset + this.reseedBytes);
    cur.drain(rotatedFile, end, this.opts, (lines) => this.accept(lines));
    if (cur.offset >= rstat.size) {
      const tail = cur.splitter.carry;
      cur.splitter.carry = "";
      if (tail.trim().length > 0) {
        this.accept([tail]);
      }
    }
    this.settleSkip();
  }

  private position(stat: fs.Stats, budget: number): void {
    const start = stat.size > budget ? stat.size - budget : 0;
    this.cursor = new Cursor(start, this.opts.maxLineChars ?? DEFAULT_MAX_LINE_CHARS);
    this.inode = stat.ino;
  }

  // Route a batch of complete lines through the post-reseed dedup.
  private accept(lines: string[]): void {
    if (!this.skipping) {
      this.emit(lines);
      return;
    }
    const idx = this.lastLine === undefined ? -1 : lines.lastIndexOf(this.lastLine);
    if (idx >= 0) {
      // Found where we left off: everything held so far was already seen.
      this.skipping = false;
      this.skipBuf = [];
      const fresh = lines.slice(idx + 1);
      if (fresh.length > 0) {
        this.emit(fresh);
      }
      return;
    }
    for (const l of lines) this.skipBuf.push(l);
  }

  // Once the whole reseed window has been read without finding the last-seen
  // line, the held lines are all new (e.g. a fresh file after rotation).
  private settleSkip(): void {
    if (!this.skipping || !this.cursor || this.cursor.offset < this.skipEnd) {
      return;
    }
    this.skipping = false;
    const held = this.skipBuf;
    this.skipBuf = [];
    if (held.length > 0) {
      this.emit(held);
    }
  }

  private noteEmitted(lines: string[]): void {
    if (lines.length > 0) {
      this.lastLine = lines[lines.length - 1];
    }
  }

  private emit(lines: string[]): void {
    this.noteEmitted(lines);
    this.opts.onLines(lines);
  }
}
