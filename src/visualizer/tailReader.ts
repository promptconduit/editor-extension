// Generic, rotation-safe tail of an append-only file, parsed line by line.
// Seeds from the newest `seedBytes` of the file (not offset 0), then reads only
// appended bytes in bounded slices. Rotation/truncation re-reads a bounded tail
// of the new file and skips lines already delivered. Watches the parent
// directory (the file may not exist yet, and a dir watch survives the inode
// swap) with a poll-loop safety net. See ../boundedTail.ts. Node-only.
import { LineTail, SliceOptions } from "../boundedTail";

// The Stream panel only keeps a few hundred rows, so a few MB of the newest
// events is plenty to paint it on open.
export const DEFAULT_SEED_BYTES = 8 * 1024 * 1024;

export interface TailReaderOptions extends SliceOptions {
  seedBytes?: number;
  reseedBytes?: number;
  pollMs?: number;
}

export class TailReader<T> {
  private readonly tail: LineTail;

  constructor(
    file: string,
    private readonly parse: (line: string) => T | null,
    private readonly onItems: (items: T[]) => void,
    opts: TailReaderOptions = {},
  ) {
    this.tail = new LineTail({
      ...opts,
      file,
      seedBytes: opts.seedBytes ?? DEFAULT_SEED_BYTES,
      onLines: (lines) => this.deliver(lines),
    });
  }

  start(): void {
    this.deliver(this.tail.readInitial()); // seed with the newest existing events
    this.tail.startWatching();
  }

  /** Poll once now (tests; the watcher/poll loop calls this in production). */
  tick(): void {
    this.tail.readNew();
  }

  dispose(): void {
    this.tail.dispose();
  }

  private deliver(lines: string[]): void {
    const items: T[] = [];
    for (const line of lines) {
      const item = this.parse(line);
      if (item !== null) items.push(item);
    }
    if (items.length > 0) this.onItems(items);
  }
}
