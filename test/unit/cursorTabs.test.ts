import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseComposerData,
  CursorTabTracker,
  MAX_CONSECUTIVE_FAILURES,
  type CursorTabsDeps,
} from "../../src/cursorTabs";

function composerJson(ids: unknown): string {
  return JSON.stringify({ lastFocusedComposerIds: ids });
}

describe("parseComposerData", () => {
  it("returns the first focused composer id", () => {
    expect(parseComposerData('{"lastFocusedComposerIds":["abc","def"]}')).toBe("abc");
  });

  it("tolerates extra keys around the one it needs", () => {
    const raw = JSON.stringify({
      hasMigratedComposerData: true,
      lastFocusedComposerIds: ["tab-1"],
      selectedComposerIds: ["tab-2", "tab-1"],
    });
    expect(parseComposerData(raw)).toBe("tab-1");
  });

  it("returns undefined when the key is missing", () => {
    expect(parseComposerData('{"selectedComposerIds":["abc"]}')).toBeUndefined();
  });

  it("returns undefined for an empty array", () => {
    expect(parseComposerData(composerJson([]))).toBeUndefined();
  });

  it("returns undefined when the first element is not a string", () => {
    expect(parseComposerData(composerJson([42, "abc"]))).toBeUndefined();
    expect(parseComposerData(composerJson([null]))).toBeUndefined();
    expect(parseComposerData(composerJson([{ id: "abc" }]))).toBeUndefined();
  });

  it("returns undefined when the first element is an empty string", () => {
    expect(parseComposerData(composerJson(["", "abc"]))).toBeUndefined();
  });

  it("returns undefined when the value is not an array", () => {
    expect(parseComposerData(composerJson("abc"))).toBeUndefined();
  });

  it("returns undefined on non-JSON garbage", () => {
    expect(parseComposerData("not json at all")).toBeUndefined();
    expect(parseComposerData("")).toBeUndefined();
  });

  it("returns undefined for null / array / scalar roots", () => {
    expect(parseComposerData("null")).toBeUndefined();
    expect(parseComposerData('["abc"]')).toBeUndefined();
    expect(parseComposerData("42")).toBeUndefined();
    expect(parseComposerData('"abc"')).toBeUndefined();
  });
});

interface TrackerHarness {
  tracker: CursorTabTracker;
  query: ReturnType<typeof vi.fn>;
  emitted: Array<string | undefined>;
  onDisabled: ReturnType<typeof vi.fn>;
}

function makeTracker(overrides: Partial<CursorTabsDeps> = {}): TrackerHarness {
  const emitted: Array<string | undefined> = [];
  const query = (overrides.query as ReturnType<typeof vi.fn>) ?? vi.fn(async () => composerJson(["abc"]));
  const onDisabled = vi.fn();
  const tracker = new CursorTabTracker({
    dbPath: () => "/fake/state.vscdb",
    onFocusedComposer: (id) => emitted.push(id),
    onDisabled,
    intervalMs: 10,
    ...overrides,
    query,
  });
  return { tracker, query, emitted, onDisabled };
}

describe("CursorTabTracker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits the composerId on the first successful poll", async () => {
    const { tracker, emitted } = makeTracker();
    await tracker.poll();
    expect(emitted).toEqual(["abc"]);
  });

  it("does not re-emit while the value is unchanged", async () => {
    const { tracker, emitted } = makeTracker();
    await tracker.poll();
    await tracker.poll();
    await tracker.poll();
    expect(emitted).toEqual(["abc"]);
  });

  it("emits again when the focused id changes, and undefined when the key disappears", async () => {
    const answers = [
      composerJson(["abc"]),
      composerJson(["def"]),
      "{}", // key gone → undefined
    ];
    const { tracker, emitted } = makeTracker({
      query: vi.fn(async () => answers.shift() ?? "{}"),
    });
    await tracker.poll();
    await tracker.poll();
    await tracker.poll();
    expect(emitted).toEqual(["abc", "def", undefined]);
  });

  it("trims sqlite3 stdout (trailing newline) before parsing", async () => {
    const { tracker, emitted } = makeTracker({
      query: vi.fn(async () => composerJson(["abc"]) + "\n"),
    });
    await tracker.poll();
    expect(emitted).toEqual(["abc"]);
  });

  it("skips the query entirely when dbPath() returns null, without counting a failure", async () => {
    const { tracker, query, onDisabled } = makeTracker({ dbPath: () => null });
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES + 2; i++) {
      await tracker.poll();
    }
    expect(query).not.toHaveBeenCalled();
    expect(onDisabled).not.toHaveBeenCalled();
    expect(tracker.isDisabled).toBe(false);
  });

  it("disables itself after MAX_CONSECUTIVE_FAILURES straight failures and never queries again", async () => {
    const { tracker, query, onDisabled, emitted } = makeTracker({
      query: vi.fn(() => Promise.reject(new Error("sqlite3 not found"))),
    });
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      await tracker.poll();
    }
    expect(onDisabled).toHaveBeenCalledTimes(1);
    expect(onDisabled).toHaveBeenCalledWith("sqlite3 not found");
    expect(tracker.isDisabled).toBe(true);
    expect(query).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES);

    // Once disabled, further polls are no-ops.
    await tracker.poll();
    await tracker.poll();
    expect(query).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES);
    expect(onDisabled).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([]);
  });

  it("resets the failure counter on success (4 fail, 1 ok, 4 fail → still alive)", async () => {
    let calls = 0;
    const { tracker, onDisabled } = makeTracker({
      query: vi.fn(() => {
        calls += 1;
        // Call 5 succeeds; calls 1-4 and 6-9 fail.
        return calls === 5
          ? Promise.resolve(composerJson(["abc"]))
          : Promise.reject(new Error("boom"));
      }),
    });
    for (let i = 0; i < 9; i++) {
      await tracker.poll();
    }
    expect(tracker.isDisabled).toBe(false);
    expect(onDisabled).not.toHaveBeenCalled();
  });

  it("dispose() stops future polling", async () => {
    vi.useFakeTimers();
    const { tracker, query } = makeTracker();
    tracker.start();
    // start() runs one immediate poll synchronously up to the query call.
    expect(query).toHaveBeenCalledTimes(1);
    tracker.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(query).toHaveBeenCalledTimes(1);
    expect(tracker.isDisabled).toBe(true);
  });

  it("start() is idempotent and refuses to restart after dispose()", async () => {
    vi.useFakeTimers();
    const { tracker, query } = makeTracker();
    tracker.start();
    tracker.start(); // second start must not double-poll
    expect(query).toHaveBeenCalledTimes(1);
    tracker.dispose();
    tracker.start(); // disposed → stays stopped
    await vi.advanceTimersByTimeAsync(200);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("polls on the configured interval until disposed", async () => {
    vi.useFakeTimers();
    const { tracker, query } = makeTracker({ intervalMs: 10 });
    tracker.start();
    await vi.advanceTimersByTimeAsync(35);
    expect(query.mock.calls.length).toBeGreaterThanOrEqual(3);
    tracker.dispose();
  });

  it("does not start a second query while one is in flight (inFlight guard)", async () => {
    let resolveQuery!: (v: string) => void;
    const query = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolveQuery = r;
        }),
    );
    const { tracker, emitted } = makeTracker({ query });
    const first = tracker.poll();
    const second = tracker.poll(); // overlaps: must bail out immediately
    expect(query).toHaveBeenCalledTimes(1);
    resolveQuery(composerJson(["abc"]));
    await first;
    await second;
    expect(emitted).toEqual(["abc"]);
    // The guard releases once the flight lands: a later poll queries again.
    const third = tracker.poll();
    expect(query).toHaveBeenCalledTimes(2);
    resolveQuery(composerJson(["abc"]));
    await third;
  });
});
