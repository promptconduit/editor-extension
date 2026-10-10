// 30-day API-equivalent spend from the local event log. Used only to decide
// whether the cost panel should offer `promptconduit login`. Never uploaded.
//
// The log can be hundreds of MB, so it is never loaded whole. The first scan
// streams each file in bounded slices; later scans read only the bytes appended
// since (offsets are tracked per inode, so the live file being renamed to .1
// keeps its progress). A rewritten file (new inode, e.g. a prune) or a
// different file reusing an inode (caught by a first-bytes fingerprint) is
// streamed again from the top; request_id dedup keeps the total exact.

import * as fs from "fs";
import { StringDecoder } from "string_decoder";
import {
  LineSplitter,
  DEFAULT_SLICE_BYTES,
  FINGERPRINT_BYTES,
  sameFile,
  type FileFingerprint,
} from "./boundedTail";
import { costEventsFrom, parseEnvelopeV2 } from "./envelope";
import { eventsJsonlPath, rotatedEventsPath } from "./visualizer/paths";

export const MONTH_WINDOW_DAYS = 30;
export const MONTH_WINDOW_MS = MONTH_WINDOW_DAYS * 24 * 60 * 60 * 1000;
/** Priced sessions before the login prompt appears. Enough to have seen a real total. */
export const LOGIN_CTA_MIN_SESSIONS = 3;

export interface MonthSpend {
  usd: number;
  sessions: number;
}

const CACHE_MS = 60_000;

interface PricedRequest {
  ts: number;
  usd: number;
  session: string;
}

/** Requests stamped further ahead than this (clock skew) are ignored. */
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Running 30-day accumulator: one entry per priced request_id. When a
 * request_id appears more than once, the copy with the earliest timestamp
 * wins, so a skewed future-dated copy can't shadow a correct one. Requests
 * already older than the window, or more than a day in the future, are not
 * kept. Slightly-future ones are kept (the scan offset has moved past them)
 * and counted once `now` reaches them. Entries that age out are pruned.
 */
export class MonthSpendAccumulator {
  private readonly reqs = new Map<string, PricedRequest>();

  constructor(private readonly windowMs = MONTH_WINDOW_MS) {}

  addLine(line: string, now: number): void {
    // Cheap pre-filter: only envelopes carrying a cost slug can contribute.
    if (!line.includes('"cost"')) {
      return;
    }
    const env = parseEnvelopeV2(line);
    if (!env) {
      return;
    }
    const cutoff = now - this.windowMs;
    for (const ev of costEventsFrom(env)) {
      if (!ev.model_priced || !ev.request_id) {
        continue;
      }
      const ts = Date.parse(ev.ts);
      if (Number.isNaN(ts) || ts < cutoff || ts > now + MAX_FUTURE_SKEW_MS) {
        continue;
      }
      const prev = this.reqs.get(ev.request_id);
      if (prev && prev.ts <= ts) {
        continue;
      }
      this.reqs.set(ev.request_id, { ts, usd: ev.cost.total, session: ev.session_id ?? "" });
    }
  }

  total(now: number): MonthSpend {
    const cutoff = now - this.windowMs;
    const sessions = new Set<string>();
    let usd = 0;
    for (const [id, r] of this.reqs) {
      if (r.ts < cutoff) {
        this.reqs.delete(id); // aged out
        continue;
      }
      if (r.ts > now) {
        continue;
      }
      usd += r.usd;
      if (r.session) {
        sessions.add(r.session);
      }
    }
    return { usd, sessions: sessions.size };
  }
}

/** Sum priced requests whose timestamp falls in [now - window, now]. */
export function accumulateMonthSpend(
  lines: Iterable<string>,
  now: number,
  windowMs = MONTH_WINDOW_MS,
): MonthSpend {
  const acc = new MonthSpendAccumulator(windowMs);
  for (const line of lines) {
    acc.addLine(line, now);
  }
  return acc.total(now);
}

interface FileProgress {
  /** Identity (dev + inode + first-bytes fingerprint; see boundedTail.sameFile). */
  fp: FileFingerprint;
  offset: number;
  decoder: StringDecoder;
  splitter: LineSplitter;
}

export interface MonthSpendScannerOptions {
  sliceBytes?: number;
  windowMs?: number;
}

/**
 * Incremental, streaming scanner over the live log and its rotation. Memory is
 * one slice plus one entry per priced request in the window.
 */
export class MonthSpendScanner {
  private readonly acc: MonthSpendAccumulator;
  // Keyed by dev:inode; the fingerprint inside guards against inode reuse.
  private progress = new Map<string, FileProgress>();
  private readonly sliceBytes: number;

  constructor(
    private readonly files: () => string[],
    opts: MonthSpendScannerOptions = {},
  ) {
    this.acc = new MonthSpendAccumulator(opts.windowMs);
    this.sliceBytes = Math.max(1, opts.sliceBytes ?? DEFAULT_SLICE_BYTES);
  }

  async scan(now: number): Promise<MonthSpend> {
    const next = new Map<string, FileProgress>();
    for (const file of this.files()) {
      await this.scanFile(file, now, next);
    }
    this.progress = next; // forget inodes that no longer exist
    return this.acc.total(now);
  }

  private async scanFile(file: string, now: number, next: Map<string, FileProgress>): Promise<void> {
    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(file, "r");
    } catch {
      return; // absent is normal
    }
    try {
      const stat = await fh.stat();
      const key = `${stat.dev}:${stat.ino}`;
      const head = Buffer.alloc(FINGERPRINT_BYTES);
      const prefix = head.subarray(0, (await fh.read(head, 0, FINGERPRINT_BYTES, 0)).bytesRead);
      let prog = this.progress.get(key);
      if (!prog || !sameFile(prog.fp, stat, prefix) || stat.size < prog.offset) {
        // New file, or a different file reusing the inode: start over.
        prog = {
          fp: { dev: stat.dev, ino: stat.ino, prefix: Buffer.from(prefix) },
          offset: 0,
          decoder: new StringDecoder("utf8"),
          splitter: new LineSplitter(false),
        };
      } else if (prefix.length > prog.fp.prefix.length) {
        prog.fp.prefix = Buffer.from(prefix); // extend the fingerprint as the file grows
      }
      next.set(key, prog);
      if (stat.size <= prog.offset) {
        return;
      }
      const buf = Buffer.allocUnsafe(Math.min(this.sliceBytes, stat.size - prog.offset));
      while (prog.offset < stat.size) {
        const len = Math.min(buf.length, stat.size - prog.offset);
        const { bytesRead } = await fh.read(buf, 0, len, prog.offset);
        if (bytesRead <= 0) {
          break;
        }
        prog.offset += bytesRead;
        for (const line of prog.splitter.push(prog.decoder.write(buf.subarray(0, bytesRead)))) {
          this.acc.addLine(line, now);
        }
      }
    } catch {
      // Keep partial progress; the next scan resumes.
    } finally {
      await fh.close().catch(() => undefined);
    }
  }
}

let scanner: MonthSpendScanner | undefined;
let cached: { at: number; spend: MonthSpend } | undefined;
let inflight: Promise<MonthSpend> | undefined;

/** Scan the live log and its one rotation (incrementally). Cached for a minute. */
export async function readMonthSpend(now = Date.now()): Promise<MonthSpend> {
  if (cached && now - cached.at < CACHE_MS && now >= cached.at) {
    return cached.spend;
  }
  if (inflight) {
    return inflight;
  }
  scanner ??= new MonthSpendScanner(() => [rotatedEventsPath(), eventsJsonlPath()]);
  inflight = scanner
    .scan(now)
    .then((spend) => {
      cached = { at: now, spend };
      return spend;
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}

/** Test hook: drop the scan cache and incremental state. */
export function resetMonthSpendCache(): void {
  cached = undefined;
  scanner = undefined;
}
