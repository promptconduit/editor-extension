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

  /**
   * The file is final (rotated away): flush the decoder's buffered bytes and
   * hand over any newline-terminated lines. The trailing fragment without a
   * newline may be a write in progress, so it is dropped, never emitted.
   */
  finish(sink: (lines: string[]) => void): void {
    const lines = this.splitter.push(this.decoder.end());
    this.splitter.carry = "";
    if (lines.length > 0) {
      sink(lines);
    }
  }
}

// ---- file identity -----------------------------------------------------------
//
// dev + inode alone is not a reliable identity: an inode number can be reused
// by a new file after a delete. A fingerprint of the file's first bytes (an
// append-only log never rewrites them) tells such files apart. Birth time is
// not used: without statx some platforms report ctime there, which changes on
// every append.

export const FINGERPRINT_BYTES = 256;

export interface FileFingerprint {
  dev: number;
  ino: number;
  /** First up-to-FINGERPRINT_BYTES bytes seen so far. */
  prefix: Buffer;
}

/** Read the first `n` bytes of a file (fewer if it is shorter). */
export function readPrefixSync(file: string, n = FINGERPRINT_BYTES): Buffer | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } catch {
    return undefined;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

/**
 * True when `current` (a fresh read of the file's first bytes) is consistent
 * with the fingerprint: same dev + inode, and the bytes we fingerprinted are
 * still the file's first bytes. A file shorter than the stored prefix does
 * not match.
 */
export function sameFile(
  fp: FileFingerprint,
  stat: { dev: number; ino: number },
  current: Buffer | undefined,
): boolean {
  if (stat.dev !== fp.dev || stat.ino !== fp.ino || current === undefined) {
    return false;
  }
  return current.length >= fp.prefix.length && current.subarray(0, fp.prefix.length).equals(fp.prefix);
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
  /**
   * Bytes re-read from the end after rotation/truncation/a rewrite. Defaults
   * to seedBytes. Plain appends are always read in full (in slices).
   */
  reseedBytes?: number;
  /**
   * Where the file is renamed to on rotation (default `${file}.1`). When the
   * live file's inode changes and this path holds the old inode, the bytes
   * appended before the rename are drained from it first (to EOF, in slices).
   */
  rotatedFile?: string;
  pollMs?: number;
}

// The CLI writes the envelope's top-level event_id near the start of each line;
// look only at the head so a nested "event_id" deep in a payload isn't picked.
const EVENT_ID_RE = /"event_id"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const EVENT_ID_HEAD_CHARS = 512;

/** Identity of a line for dedup: its envelope event_id, else the full text. */
export function lineKey(line: string): string {
  const m = EVENT_ID_RE.exec(line.length > EVENT_ID_HEAD_CHARS ? line.slice(0, EVENT_ID_HEAD_CHARS) : line);
  return m ? `id:${m[1]}` : `txt:${line}`;
}

export class LineTail {
  private cursor: Cursor | undefined; // undefined = not positioned (file absent)
  // Identity of the file the cursor reads (see sameFile). Undefined until positioned.
  private fp: FileFingerprint | undefined;
  // lineKey() of the last emitted line: its envelope event_id when present (so
  // a rewrite that alters the line, e.g. a reprice, still matches), else text.
  private lastKey: string | undefined;
  // Dedup after a reseed: lines are held back until `lastKey` is found (emit
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
  private readonly rotatedFile: string;

  constructor(private readonly opts: LineTailOptions) {
    this.reseedBytes = opts.reseedBytes ?? opts.seedBytes;
    this.rotatedFile = opts.rotatedFile ?? `${opts.file}.1`;
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
    const cur = this.cursor;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.opts.file);
    } catch {
      // Gone (deleted, or mid-rename). If it was renamed to the rotated path,
      // finish it from there now; the file is re-seeded when it reappears.
      if (cur && this.fp) {
        this.drainRotated(cur);
      }
      this.cursor = undefined;
      return;
    }
    let reseed = !cur || !this.fp;
    if (cur && this.fp) {
      const prefix = readPrefixSync(this.opts.file);
      if (!sameFile(this.fp, stat, prefix)) {
        // A different file now lives at the path: renamed away (rotation /
        // prune rewrite), or deleted and recreated, possibly reusing the inode.
        this.drainRotated(cur);
        reseed = true;
      } else {
        if (prefix && prefix.length > this.fp.prefix.length) {
          this.fp.prefix = prefix; // extend the fingerprint as the file grows
        }
        // Same file: read every appended byte (sliced), however many. Only a
        // shrink means our offset is meaningless.
        reseed = stat.size < cur.offset;
      }
    }
    if (reseed) {
      // A skip window still open here was cut short before reaching lastKey,
      // so what it holds may already have been delivered: discard it and
      // restart the skip against the same lastKey in the new window.
      this.skipBuf = [];
      this.position(stat, this.reseedBytes);
      this.skipping = this.lastKey !== undefined;
      this.skipEnd = stat.size;
    }
    this.cursor!.drain(this.opts.file, stat.size, this.opts, (lines) => this.accept(lines));
    this.settleSkip();
  }

  // The file we were reading was replaced. If the rotated path holds that same
  // file (identity, not just inode), finish it from our offset (bounded by the
  // EOF, in slices). Only newline-terminated lines are emitted.
  private drainRotated(cur: Cursor): void {
    if (!this.fp) {
      return;
    }
    let rstat: fs.Stats;
    try {
      rstat = fs.statSync(this.rotatedFile);
    } catch {
      return;
    }
    if (rstat.size < cur.offset || !sameFile(this.fp, rstat, readPrefixSync(this.rotatedFile))) {
      return;
    }
    cur.drain(this.rotatedFile, rstat.size, this.opts, (lines) => this.accept(lines));
    if (cur.offset >= rstat.size) {
      cur.finish((lines) => this.accept(lines));
    }
    this.fp = undefined; // done with that file; never drain it twice
    this.settleSkip();
  }

  private position(stat: fs.Stats, budget: number): void {
    const start = stat.size > budget ? stat.size - budget : 0;
    this.cursor = new Cursor(start, this.opts.maxLineChars ?? DEFAULT_MAX_LINE_CHARS);
    this.fp = { dev: stat.dev, ino: stat.ino, prefix: readPrefixSync(this.opts.file) ?? Buffer.alloc(0) };
  }

  // Route a batch of complete lines through the post-reseed dedup.
  private accept(lines: string[]): void {
    if (!this.skipping) {
      this.emit(lines);
      return;
    }
    let idx = -1;
    if (this.lastKey !== undefined) {
      for (let k = lines.length - 1; k >= 0; k--) {
        if (lineKey(lines[k]) === this.lastKey) {
          idx = k;
          break;
        }
      }
    }
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
    if (this.skipping && this.cursor && this.cursor.offset >= this.skipEnd) {
      this.flushSkip();
    }
  }

  // Stop skipping and emit whatever is held.
  private flushSkip(): void {
    if (!this.skipping) {
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
      this.lastKey = lineKey(lines[lines.length - 1]);
    }
  }

  private emit(lines: string[]): void {
    this.noteEmitted(lines);
    this.opts.onLines(lines);
  }
}
