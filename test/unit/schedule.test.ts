import { describe, it, expect } from "vitest";
import { buildSchedule, PlaybackClock } from "../../src/visualizer/schedule";
import type { PlaybackTimeline } from "../../src/visualizer/types";

function timeline(events: PlaybackTimeline["events"]): PlaybackTimeline {
  const ts = events.map((e) => e.t);
  return { events, tStart: Math.min(...ts), tEnd: Math.max(...ts) };
}

describe("buildSchedule", () => {
  it("clamps inter-event gaps into [minGap, maxGap] and stays monotonic", () => {
    const tl = timeline([
      { t: 0, type: "session_start", ref: "session" },
      { t: 10, type: "node_spawn", ref: "agent" }, // 10ms gap → clamped up to 90
      { t: 5010, type: "tool_start", ref: "u1" }, // 5000ms gap → clamped down to 1200
      { t: 5510, type: "tool_end", ref: "u1" }, // 500ms gap → unchanged
    ]);
    const s = buildSchedule(tl, { minGapMs: 90, maxGapMs: 1200, tailPadMs: 1000 });
    const ps = s.marks.map((m) => m.p);
    expect(ps).toEqual([0, 90, 1290, 1790]);
    // strictly non-decreasing
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThanOrEqual(ps[i - 1]);
    expect(s.duration).toBe(1790 + 1000);
  });

  it("indexes spawn/end/tool times for fast lookup", () => {
    const tl = timeline([
      { t: 0, type: "session_start", ref: "session" },
      { t: 100, type: "node_spawn", ref: "agent" },
      { t: 200, type: "tool_start", ref: "u1" },
      { t: 300, type: "tool_end", ref: "u1" },
      { t: 400, type: "node_end", ref: "agent" },
    ]);
    const s = buildSchedule(tl);
    expect(s.sessionStart).toBe(0);
    expect(s.nodeSpawn.get("agent")).toBeGreaterThan(0);
    expect(s.nodeEnd.get("agent")).toBeGreaterThan(s.nodeSpawn.get("agent")!);
    expect(s.toolStart.get("u1")).toBeDefined();
    expect(s.toolEnd.get("u1")).toBeGreaterThan(s.toolStart.get("u1")!);
  });

  it("handles an empty timeline", () => {
    const s = buildSchedule({ events: [], tStart: 0, tEnd: 0 }, { tailPadMs: 500 });
    expect(s.marks).toEqual([]);
    expect(s.duration).toBe(500);
  });
});

describe("PlaybackClock", () => {
  const sched = buildSchedule(
    timeline([
      { t: 0, type: "session_start", ref: "session" },
      { t: 1000, type: "tool_start", ref: "u1" },
    ]),
    { minGapMs: 1000, maxGapMs: 1000, tailPadMs: 0 },
  );
  // duration = one gap of 1000 + 0 pad = 1000

  it("advances by delta * speed and stops at the end", () => {
    const c = new PlaybackClock(sched);
    expect(c.duration).toBe(1000);
    c.tick(250);
    expect(c.time).toBe(250);
    c.setSpeed(2);
    c.tick(250); // 250 * 2 = 500
    expect(c.time).toBe(750);
    c.tick(1000); // clamps to duration
    expect(c.time).toBe(1000);
    expect(c.ended).toBe(true);
    expect(c.playing).toBe(false);
  });

  it("does not advance while paused", () => {
    const c = new PlaybackClock(sched);
    c.pause();
    c.tick(500);
    expect(c.time).toBe(0);
  });

  it("seeks by fraction and replays from the top after ending", () => {
    const c = new PlaybackClock(sched);
    c.seekFrac(0.5);
    expect(c.time).toBe(500);
    c.seekFrac(2); // clamps
    expect(c.time).toBe(1000);
    c.play(); // ended → rewind
    expect(c.time).toBe(0);
    expect(c.playing).toBe(true);
  });
});
