import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { LineTail, LineSplitter, readTailLines, lineKey } from "../../src/boundedTail";
import { TailReader } from "../../src/visualizer/tailReader";
import { RawEventTail } from "../../src/tail";
import { readHistory } from "../../src/visualizer/eventLog";
import { MonthSpendScanner, accumulateMonthSpend } from "../../src/monthSpend";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-tail-"));
  file = path.join(dir, "events.jsonl");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const ln = (i: number, pad = 0): string => JSON.stringify({ i, pad: "x".repeat(pad) });
const lines = (from: number, to: number, pad = 0): string =>
  Array.from({ length: to - from }, (_, k) => ln(from + k, pad) + "\n").join("");
const ids = (ls: string[]): number[] => ls.map((l) => (JSON.parse(l) as { i: number }).i);

function makeTail(opts: Partial<ConstructorParameters<typeof LineTail>[0]> = {}) {
  const got: string[] = [];
  const tail = new LineTail({
    file,
    seedBytes: 1024,
    sliceBytes: 64,
    onLines: (ls) => got.push(...ls),
    ...opts,
  });
  return { tail, got };
}

describe("LineSplitter", () => {
  it("carries partial lines across pushes and skips a leading partial line", () => {
    const s = new LineSplitter(true);
    expect(s.push('tial"}\n{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\n')).toEqual(['{"b":2}']);
  });

  it("drops an oversized fragment and resyncs at the next newline", () => {
    const s = new LineSplitter(false, 10);
    expect(s.push("y".repeat(50))).toEqual([]);
    expect(s.push("zzz\nok\n")).toEqual(["ok"]);
  });
});

describe("LineTail", () => {
  it("seeds from the newest seedBytes, never from offset 0, and drops the partial first line", () => {
    fs.writeFileSync(file, lines(0, 500, 20)); // ~16KB
    const { tail } = makeTail({ seedBytes: 1000 });
    const seed = ids(tail.readInitial());
    expect(seed.length).toBeGreaterThan(5);
    expect(seed[0]).toBeGreaterThan(400);
    expect(seed[seed.length - 1]).toBe(499);
    // Seeded lines are contiguous (no fragment, no gap).
    seed.forEach((v, k) => expect(v).toBe(seed[0] + k));
    expect(tail.offset).toBe(fs.statSync(file).size);
  });

  it("keeps a line that starts exactly at the seed boundary", () => {
    const body = lines(0, 10);
    fs.writeFileSync(file, body);
    const lastLen = ln(9).length + 1;
    const { tail } = makeTail({ seedBytes: lastLen });
    expect(ids(tail.readInitial())).toEqual([9]);
  });

  it("reads appends in bounded slices and advances the offset per slice", () => {
    fs.writeFileSync(file, "");
    const sizes: number[] = [];
    const { tail, got } = makeTail({
      seedBytes: 1 << 20,
      reseedBytes: 1 << 20,
      sliceBytes: 100,
      readSync: (fd, buf, off, len, pos) => {
        sizes.push(len);
        return fs.readSync(fd, buf, off, len, pos);
      },
    });
    tail.readInitial();
    fs.appendFileSync(file, lines(0, 200, 10));
    tail.readNew();
    expect(ids(got)).toEqual(Array.from({ length: 200 }, (_, k) => k));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
    expect(tail.offset).toBe(fs.statSync(file).size);
  });

  it("does not wedge when a slice read fails: progress is kept and the next poll resumes", () => {
    fs.writeFileSync(file, "");
    let calls = 0;
    const { tail, got } = makeTail({
      seedBytes: 1 << 20,
      reseedBytes: 1 << 20,
      sliceBytes: 50,
      readSync: (fd, buf, off, len, pos) => {
        calls += 1;
        if (calls === 3) throw new Error("Cannot create a string longer than 0x1fffffe8 characters");
        return fs.readSync(fd, buf, off, len, pos);
      },
    });
    tail.readInitial();
    fs.appendFileSync(file, lines(0, 30));
    tail.readNew();
    const afterFail = tail.offset;
    expect(afterFail).toBeGreaterThan(0); // two slices landed before the failure
    tail.readNew();
    expect(tail.offset).toBe(fs.statSync(file).size);
    expect(ids(got)).toEqual(Array.from({ length: 30 }, (_, k) => k));
  });

  it("carries a partial trailing line until its newline arrives", () => {
    fs.writeFileSync(file, ln(0) + "\n" + '{"i":1,');
    const { tail, got } = makeTail({ seedBytes: 1 << 20 });
    expect(ids(tail.readInitial())).toEqual([0]);
    fs.appendFileSync(file, '"pad":""}\n');
    tail.readNew();
    expect(ids(got)).toEqual([1]);
  });

  it("on a rewrite (new inode) re-reads a bounded tail and skips lines already seen", () => {
    fs.writeFileSync(file, lines(0, 100));
    const sizes: number[] = [];
    const { tail, got } = makeTail({
      seedBytes: 1 << 20,
      reseedBytes: 400,
      readSync: (fd, buf, off, len, pos) => {
        sizes.push(pos);
        return fs.readSync(fd, buf, off, len, pos);
      },
    });
    tail.readInitial();
    // Prune-style rewrite: drop the oldest half, keep the rest, add new lines;
    // written to a temp file and renamed over (new inode).
    const tmp = path.join(dir, "events.jsonl.tmp");
    fs.writeFileSync(tmp, lines(50, 100) + lines(100, 105));
    fs.renameSync(tmp, file);
    sizes.length = 0;
    tail.readNew();
    expect(ids(got)).toEqual([100, 101, 102, 103, 104]);
    // Bounded: the re-read never started at the top of the new file.
    expect(Math.min(...sizes)).toBeGreaterThan(0);
  });

  it("keeps deduplicating across polls when the reseed read stops part-way", () => {
    fs.writeFileSync(file, lines(0, 100));
    let failNext = false;
    const { tail, got } = makeTail({
      seedBytes: 1 << 20,
      reseedBytes: 1 << 20,
      sliceBytes: 64,
      readSync: (fd, buf, off, len, pos) => {
        if (failNext) {
          failNext = false;
          throw new Error("EIO");
        }
        return fs.readSync(fd, buf, off, len, pos);
      },
    });
    tail.readInitial();
    // Rewrite (new inode) that keeps every already-seen line, then adds two.
    const tmp = path.join(dir, "rw.tmp");
    fs.writeFileSync(tmp, lines(0, 100) + lines(100, 102));
    fs.renameSync(tmp, file);
    failNext = true; // the very first slice of the reseed read fails
    tail.readNew();
    expect(got).toEqual([]);
    tail.readNew(); // resumes on the normal path: must still skip seen lines
    expect(ids(got)).toEqual([100, 101]);
  });

  it("drains lines appended to the old file before it was rotated away", () => {
    fs.writeFileSync(file, lines(0, 10));
    const { tail, got } = makeTail({ seedBytes: 1 << 20 });
    tail.readInitial();
    // Appended after our last poll, then rotated before the next one; the last
    // line never got its newline (possibly a write in progress) so it is
    // dropped rather than emitted as a complete line.
    fs.appendFileSync(file, lines(10, 12) + ln(12));
    fs.renameSync(file, `${file}.1`);
    fs.writeFileSync(file, lines(13, 15));
    tail.readNew();
    expect(ids(got)).toEqual([10, 11, 13, 14]);
  });

  it("drains a rotated remainder with multi-byte text split across slices", () => {
    fs.writeFileSync(file, lines(0, 2));
    const { tail, got } = makeTail({ seedBytes: 1 << 20, sliceBytes: 7 });
    tail.readInitial();
    const wide = JSON.stringify({ i: 2, s: "日本語 🚀 é".repeat(5) });
    fs.appendFileSync(file, wide + "\n");
    fs.renameSync(file, `${file}.1`);
    fs.writeFileSync(file, lines(3, 4));
    tail.readNew();
    expect(got).toEqual([wide, ln(3)]);
  });

  it("treats a same-inode file with different first bytes as a new file", () => {
    // Stand-in for delete + recreate reusing the inode: rewritten in place
    // (same inode), larger than our offset, different content.
    fs.writeFileSync(file, lines(0, 10));
    const { tail, got } = makeTail({ seedBytes: 1 << 20 });
    tail.readInitial();
    const ino = fs.statSync(file).ino;
    fs.writeFileSync(file, lines(100, 130));
    expect(fs.statSync(file).ino).toBe(ino);
    tail.readNew();
    expect(ids(got)).toEqual(Array.from({ length: 30 }, (_, k) => 100 + k));
  });

  it("does not treat a growing file as replaced (fingerprint extends as it grows)", () => {
    fs.writeFileSync(file, '{"i":0}\n'); // shorter than the fingerprint
    const { tail, got } = makeTail({ seedBytes: 1 << 20 });
    tail.readInitial();
    for (let k = 1; k < 40; k++) {
      fs.appendFileSync(file, ln(k) + "\n");
      tail.readNew();
    }
    expect(ids(got)).toEqual(Array.from({ length: 39 }, (_, k) => k + 1));
  });

  it("a cut-short skip window is discarded, and the skip restarts against the same last line", () => {
    fs.writeFileSync(file, lines(0, 10));
    let reads = 0;
    let failAt = -1;
    const { tail, got } = makeTail({
      seedBytes: 1 << 20,
      reseedBytes: 1 << 20,
      sliceBytes: 40,
      readSync: (fd, buf, off, len, pos) => {
        reads += 1;
        if (reads === failAt) throw new Error("EIO");
        return fs.readSync(fd, buf, off, len, pos);
      },
    });
    tail.readInitial();
    // Rewrite #1 keeps the seen lines 0..9 and adds 10..11; its reseed read
    // fails part-way, before reaching line 9, so it holds already-seen lines.
    const tmp = path.join(dir, "rw.tmp");
    fs.writeFileSync(tmp, lines(0, 12));
    fs.renameSync(tmp, file);
    failAt = reads + 3;
    tail.readNew();
    expect(got).toEqual([]);
    // Rewrite #2 before the next poll (still containing line 9).
    fs.writeFileSync(tmp, lines(0, 14));
    fs.renameSync(tmp, file);
    tail.readNew();
    expect(ids(got)).toEqual([10, 11, 12, 13]); // no re-delivery of 0..9
  });

  it("dedups a rewrite by event_id even when the last-seen line was altered", () => {
    const ev = (id: string, usd: number) => JSON.stringify({ schema: 2, event_id: id, usd });
    fs.writeFileSync(file, [ev("e1", 1), ev("e2", 2), ev("e3", 3)].join("\n") + "\n");
    const { tail, got } = makeTail({ seedBytes: 1 << 20 });
    tail.readInitial();
    // A reprice rewrite: same events, new numbers, plus one new event.
    const tmp = path.join(dir, "rp.tmp");
    fs.writeFileSync(tmp, [ev("e1", 10), ev("e2", 20), ev("e3", 30), ev("e4", 4)].join("\n") + "\n");
    fs.renameSync(tmp, file);
    tail.readNew();
    expect(got).toEqual([ev("e4", 4)]);
  });

  it("lineKey uses the envelope event_id and falls back to the text", () => {
    expect(lineKey('{"schema":2,"event_id":"abc","x":1}')).toBe("id:abc");
    expect(lineKey('{"schema":2,"event_id":"abc","x":2}')).toBe("id:abc");
    expect(lineKey('{"i":1}')).toBe('txt:{"i":1}');
    // A nested event_id far into the payload is not mistaken for the envelope's.
    expect(lineKey(`{"i":1,"pad":"${"x".repeat(600)}","raw":{"event_id":"n"}}`)).toMatch(/^txt:/);
  });

  it("reads every appended byte of the same file, even past the reseed budget", () => {
    fs.writeFileSync(file, lines(0, 5));
    const { tail, got } = makeTail({ seedBytes: 1 << 20, reseedBytes: 200, sliceBytes: 64 });
    tail.readInitial();
    fs.appendFileSync(file, lines(5, 305)); // far more than 200 bytes in one poll
    tail.readNew();
    expect(ids(got)).toEqual(Array.from({ length: 300 }, (_, k) => k + 5));
  });

  it("drains the rotated remainder to EOF, past the reseed budget", () => {
    fs.writeFileSync(file, lines(0, 5));
    const { tail, got } = makeTail({ seedBytes: 1 << 20, reseedBytes: 200, sliceBytes: 64 });
    tail.readInitial();
    fs.appendFileSync(file, lines(5, 305));
    fs.renameSync(file, `${file}.1`);
    fs.writeFileSync(file, lines(305, 307));
    tail.readNew();
    expect(ids(got)).toEqual(Array.from({ length: 302 }, (_, k) => k + 5));
  });

  it("after rotation to a fresh file, emits every line of the new file", () => {
    fs.writeFileSync(file, lines(0, 20));
    const { tail, got } = makeTail({ seedBytes: 1 << 20 });
    tail.readInitial();
    fs.renameSync(file, `${file}.1`);
    fs.writeFileSync(file, lines(20, 23));
    tail.readNew();
    expect(ids(got)).toEqual([20, 21, 22]);
  });

  it("on truncation in place re-reads the new content", () => {
    fs.writeFileSync(file, lines(0, 50));
    const { tail, got } = makeTail({ seedBytes: 1 << 20 });
    tail.readInitial();
    fs.truncateSync(file, 0);
    fs.appendFileSync(file, lines(50, 52));
    tail.readNew();
    expect(ids(got)).toEqual([50, 51]);
  });

  it("re-seeds boundedly when the file appears after being absent", () => {
    const { tail, got } = makeTail({ seedBytes: 1 << 20, reseedBytes: 300 });
    expect(tail.readInitial()).toEqual([]);
    fs.writeFileSync(file, lines(0, 200));
    tail.readNew();
    expect(got.length).toBeGreaterThan(0);
    expect(ids(got)[0]).toBeGreaterThan(150);
    expect(ids(got).at(-1)).toBe(199);
  });

  it("decodes multi-byte characters split across slices", () => {
    const text = JSON.stringify({ i: 0, s: "héllo — 日本語 🚀".repeat(20) }) + "\n";
    fs.writeFileSync(file, "");
    const { tail, got } = makeTail({ seedBytes: 1 << 20, reseedBytes: 1 << 20, sliceBytes: 7 });
    tail.readInitial();
    fs.appendFileSync(file, text);
    tail.readNew();
    expect(got).toEqual([text.trimEnd()]);
  });
});

describe("TailReader (Stream panel)", () => {
  it("seeds from the tail instead of reading the whole file", () => {
    fs.writeFileSync(file, lines(0, 1000, 30));
    const items: number[] = [];
    const r = new TailReader<number>(
      file,
      (l) => (JSON.parse(l) as { i: number }).i,
      (xs) => items.push(...xs),
      { seedBytes: 2000, sliceBytes: 256 },
    );
    r.start();
    r.dispose();
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(100);
    expect(items.at(-1)).toBe(999);
  });
});

describe("large log", () => {
  it("opening a multi-MB log reads only the seed budget, in slices", () => {
    // ~6MB synthetic log; production logs can be hundreds of MB.
    const chunk = lines(0, 5000, 100);
    const fd = fs.openSync(file, "w");
    for (let k = 0; k < 10; k++) fs.writeSync(fd, chunk);
    fs.closeSync(fd);
    let bytes = 0;
    let maxLen = 0;
    const items: number[] = [];
    const r = new TailReader<number>(
      file,
      (l) => (JSON.parse(l) as { i: number }).i,
      (xs) => items.push(...xs),
      {
        seedBytes: 256 * 1024,
        sliceBytes: 32 * 1024,
        readSync: (f, buf, off, len, pos) => {
          maxLen = Math.max(maxLen, len);
          const n = fs.readSync(f, buf, off, len, pos);
          bytes += n;
          return n;
        },
      },
    );
    r.start();
    fs.appendFileSync(file, ln(123456) + "\n");
    r.tick();
    r.dispose();
    expect(bytes).toBeLessThanOrEqual(256 * 1024 + 1 + ln(123456).length + 1);
    expect(maxLen).toBeLessThanOrEqual(32 * 1024);
    expect(items.at(-1)).toBe(123456);
  });
});

describe("RawEventTail", () => {
  it("initial read is bounded, tops up from .1, then tails appends exactly once", () => {
    fs.writeFileSync(`${file}.1`, lines(0, 10));
    fs.writeFileSync(file, lines(10, 20));
    const calls: { ids: number[]; initial: boolean }[] = [];
    const t = new RawEventTail({
      file,
      maxBytes: 200_000,
      sliceBytes: 64,
      pollMs: 60_000,
      onLines: (ls, initial) => calls.push({ ids: ids(ls), initial }),
    });
    t.start();
    fs.appendFileSync(file, lines(20, 22));
    t.tick();
    t.tick();
    t.dispose();
    expect(calls[0]).toEqual({ ids: Array.from({ length: 20 }, (_, k) => k), initial: true });
    expect(calls.slice(1).flatMap((c) => c.ids)).toEqual([20, 21]);
    expect(calls.slice(1).every((c) => !c.initial)).toBe(true);
  });

  it("on rotation (new inode) does not restart from offset 0", () => {
    fs.writeFileSync(file, lines(0, 300, 20));
    const got: number[] = [];
    const t = new RawEventTail({
      file,
      maxBytes: 1 << 20,
      reseedBytes: 500,
      pollMs: 60_000,
      onLines: (ls, initial) => {
        if (!initial) got.push(...ids(ls));
      },
    });
    t.start();
    // A rewrite whose last-seen line was pruned away entirely: only a bounded
    // tail of the new file is ingested, not the whole thing.
    const tmp = path.join(dir, "rewrite.tmp");
    fs.writeFileSync(tmp, lines(1000, 1300, 20));
    fs.renameSync(tmp, file);
    t.tick();
    t.dispose();
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(30);
    expect(got.at(-1)).toBe(1299);
  });
});

describe("readTailLines / readHistory", () => {
  it("reads only the newest maxBytes", () => {
    fs.writeFileSync(file, lines(0, 1000));
    const r = readTailLines(file, 300, { sliceBytes: 32 });
    expect(ids(r.lines).at(-1)).toBe(999);
    expect(r.lines.length).toBeLessThan(40);
  });

  it("readHistory is bounded to the newest bytes across .1 and the live file", () => {
    const home = dir;
    const pc = path.join(home, ".promptconduit");
    fs.mkdirSync(pc);
    const env = (id: string) =>
      JSON.stringify({ schema: 2, event_id: id, session_id: "s", tool: "claude-code", hook_event: id, captured_at: new Date().toISOString(), raw_event: {}, enrichments: {} });
    fs.writeFileSync(path.join(pc, "events.jsonl.1"), Array.from({ length: 200 }, (_, k) => env(`old${k}`) + "\n").join(""));
    fs.writeFileSync(path.join(pc, "events.jsonl"), Array.from({ length: 5 }, (_, k) => env(`new${k}`) + "\n").join(""));
    const out = readHistory(home, 3000);
    expect(out.length).toBeLessThan(205);
    expect(out.at(-1)?.hookEvent).toBe("new4");
    expect(out.some((e) => e.hookEvent === "old199")).toBe(true);
    expect(out.some((e) => e.hookEvent === "old0")).toBe(false);
  });
});

describe("MonthSpendScanner", () => {
  const NOW = Date.parse("2026-09-25T12:00:00Z");
  const cost = (id: string, session: string, total: number, daysAgo = 1) => {
    const ts = new Date(NOW - daysAgo * 86_400_000).toISOString();
    return JSON.stringify({
      schema: 2,
      event_id: id,
      session_id: session,
      tool: "cursor",
      hook_event: "stop",
      captured_at: ts,
      raw_event: {},
      enrichments: {
        cost: {
          requests: [
            {
              request_id: id,
              ts,
              model: "m",
              model_priced: true,
              tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
              usd: { input: 0, output: 0, cache_read: 0, cache_write: 0, total, currency: "USD" },
            },
          ],
        },
      },
    });
  };

  it("streams in slices, reads only new bytes on rescan, and survives a rewrite without double counting", async () => {
    const all = [cost("a", "s1", 1), cost("b", "s2", 2), cost("old", "s9", 50, 45)];
    fs.writeFileSync(file, all.join("\n") + "\n");
    const scanner = new MonthSpendScanner(() => [`${file}.1`, file], { sliceBytes: 37 });
    expect(await scanner.scan(NOW)).toEqual({ usd: 3, sessions: 2 });

    fs.appendFileSync(file, cost("c", "s3", 4) + "\n");
    expect(await scanner.scan(NOW)).toEqual({ usd: 7, sessions: 3 });

    // Prune rewrite (new inode) keeps a, b, c and adds d: no double counting.
    const tmp = path.join(dir, "p.tmp");
    fs.writeFileSync(tmp, [cost("a", "s1", 1), cost("b", "s2", 2), cost("c", "s3", 4), cost("d", "s3", 8)].join("\n") + "\n");
    fs.renameSync(tmp, file);
    expect(await scanner.scan(NOW)).toEqual({ usd: 15, sessions: 3 });

    // Rotation: live -> .1 keeps progress; the fresh live file is read from 0.
    fs.renameSync(file, `${file}.1`);
    fs.writeFileSync(file, cost("e", "s4", 16) + "\n");
    expect(await scanner.scan(NOW)).toEqual({ usd: 31, sessions: 4 });
  });

  it("counts a future-dated request once now reaches it (not dropped at ingest)", async () => {
    // Clock skew: an event stamped 1h ahead of the scan's `now`.
    fs.writeFileSync(file, cost("future", "s1", 5, -1 / 24) + "\n");
    const scanner = new MonthSpendScanner(() => [file]);
    expect(await scanner.scan(NOW)).toEqual({ usd: 0, sessions: 0 });
    // Nothing new appended; the offset is past the line, yet it now counts.
    expect(await scanner.scan(NOW + 2 * 3_600_000)).toEqual({ usd: 5, sessions: 1 });
  });

  it("resets progress when the same inode holds a different file", async () => {
    const scanner = new MonthSpendScanner(() => [file]);
    fs.writeFileSync(file, cost("a", "s1", 1) + "\n");
    expect(await scanner.scan(NOW)).toEqual({ usd: 1, sessions: 1 });
    const ino = fs.statSync(file).ino;
    // Rewritten in place (same inode; stand-in for inode reuse after a delete):
    // larger, and its first bytes are requests we have never seen.
    fs.writeFileSync(file, cost("b", "s2", 2) + "\n" + cost("c", "s3", 4) + "\n");
    expect(fs.statSync(file).ino).toBe(ino);
    expect(await scanner.scan(NOW)).toEqual({ usd: 7, sessions: 3 });
  });

  it("does not re-read a file that only grew (identity is stable across appends)", async () => {
    const first = cost("a", "s1", 1); // > FINGERPRINT_BYTES, so the fingerprint sits in it
    expect(first.length).toBeGreaterThan(256);
    fs.writeFileSync(file, first + "\n" + cost("x", "s2", 2) + "\n");
    const scanner = new MonthSpendScanner(() => [file]);
    expect(await scanner.scan(NOW)).toEqual({ usd: 3, sessions: 2 });
    // Overwrite the already-scanned 2nd line in place (same length, beyond the
    // fingerprint). Only a full re-read could see it.
    const fd = fs.openSync(file, "r+");
    fs.writeSync(fd, cost("y", "s9", 2), first.length + 1);
    fs.closeSync(fd);
    fs.appendFileSync(file, cost("b", "s3", 4) + "\n");
    expect(await scanner.scan(NOW)).toEqual({ usd: 7, sessions: 3 }); // y not counted
  });

  it("reflects repriced values after a rewrite (same request_id, same ts)", async () => {
    fs.writeFileSync(file, cost("a", "s1", 1) + "\n" + cost("b", "s2", 2) + "\n");
    const scanner = new MonthSpendScanner(() => [`${file}.1`, file]);
    expect(await scanner.scan(NOW)).toEqual({ usd: 3, sessions: 2 });
    // `cost reprice`-style rewrite: same requests and timestamps, new totals.
    const tmp = path.join(dir, "rp.tmp");
    fs.writeFileSync(tmp, cost("a", "s1", 1.5) + "\n" + cost("b", "s2", 4) + "\n");
    fs.renameSync(tmp, file);
    expect(await scanner.scan(NOW)).toEqual({ usd: 5.5, sessions: 2 });
  });

  it("prefers the correctly dated copy over a future-dated duplicate", async () => {
    const skewed = cost("dup", "s1", 5, -1 / 24); // 1h ahead
    const correct = cost("dup", "s1", 5, 1);
    expect(accumulateMonthSpend([skewed, correct], NOW)).toEqual({ usd: 5, sessions: 1 });
    // Way-future copies (> 1 day ahead) are ignored at ingest entirely.
    expect(accumulateMonthSpend([cost("far", "s2", 9, -3)], NOW)).toEqual({
      usd: 0,
      sessions: 0,
    });
  });

  it("matches accumulateMonthSpend over the same lines", async () => {
    const ls = [cost("a", "s1", 1), cost("a", "s1", 1), cost("b", "s2", 0.5), "garbage", cost("z", "s5", 9, 40)];
    fs.writeFileSync(file, ls.join("\n") + "\n");
    const scanner = new MonthSpendScanner(() => [file], { sliceBytes: 11 });
    expect(await scanner.scan(NOW)).toEqual(accumulateMonthSpend(ls, NOW));
  });
});
