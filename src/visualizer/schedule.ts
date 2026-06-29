// Cinematic playback scheduler. Real sessions have wildly uneven gaps (idle
// minutes between bursts), so we map real capture time onto a compressed
// "playback" timeline: clamp every inter-event gap into [MIN_GAP, MAX_GAP] so
// dead air collapses but rhythm is preserved. Pure (no Node) — runs in the
// webview so transport (play/pause/seek/speed) is instant.
import type { PlaybackTimeline, TimelineEvent } from "./types";

export interface ScheduleOpts {
  minGapMs?: number;
  maxGapMs?: number;
  tailPadMs?: number; // trailing dwell so the final beat doesn't snap to black
}

const DEFAULTS: Required<ScheduleOpts> = {
  minGapMs: 90,
  maxGapMs: 1200,
  tailPadMs: 1500,
};

export interface ScheduleMark {
  ev: TimelineEvent;
  p: number; // playback time (ms)
}

export interface PlaybackSchedule {
  marks: ScheduleMark[];
  duration: number;
  // Fast lookups (playback time of the first occurrence of each ref/kind).
  nodeSpawn: Map<string, number>;
  nodeEnd: Map<string, number>;
  toolStart: Map<string, number>;
  toolEnd: Map<string, number>;
  sessionStart: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Compress a real timeline into monotonic playback times. */
export function buildSchedule(timeline: PlaybackTimeline, opts?: ScheduleOpts): PlaybackSchedule {
  const o = { ...DEFAULTS, ...opts };
  const sorted = timeline.events.slice().sort((a, b) => a.t - b.t);

  const marks: ScheduleMark[] = [];
  const nodeSpawn = new Map<string, number>();
  const nodeEnd = new Map<string, number>();
  const toolStart = new Map<string, number>();
  const toolEnd = new Map<string, number>();
  let sessionStart = 0;

  let p = 0;
  let prevT: number | undefined;
  for (const ev of sorted) {
    if (prevT !== undefined) {
      p += clamp(ev.t - prevT, o.minGapMs, o.maxGapMs);
    }
    prevT = ev.t;
    marks.push({ ev, p });
    switch (ev.type) {
      case "session_start":
        sessionStart = p;
        break;
      case "node_spawn":
        if (!nodeSpawn.has(ev.ref)) nodeSpawn.set(ev.ref, p);
        break;
      case "node_end":
        if (!nodeEnd.has(ev.ref)) nodeEnd.set(ev.ref, p);
        break;
      case "tool_start":
        if (!toolStart.has(ev.ref)) toolStart.set(ev.ref, p);
        break;
      case "tool_end":
        if (!toolEnd.has(ev.ref)) toolEnd.set(ev.ref, p);
        break;
    }
  }

  return {
    marks,
    duration: p + o.tailPadMs,
    nodeSpawn,
    nodeEnd,
    toolStart,
    toolEnd,
    sessionStart,
  };
}

/**
 * The playback clock. Owns the current playback time and transport state; the
 * renderer ticks it each frame and queries `time` to decide what is visible.
 */
export class PlaybackClock {
  private pt = 0;
  playing = true;
  speed = 1;

  constructor(public readonly schedule: PlaybackSchedule) {}

  get duration(): number {
    return this.schedule.duration;
  }
  get time(): number {
    return this.pt;
  }
  get progress(): number {
    return this.duration > 0 ? this.pt / this.duration : 0;
  }
  get ended(): boolean {
    return this.pt >= this.duration;
  }

  /** Advance by a wall-clock delta scaled by speed. Stops at the end. */
  tick(deltaMs: number): void {
    if (!this.playing) return;
    this.pt = Math.min(this.pt + deltaMs * this.speed, this.duration);
    if (this.pt >= this.duration) this.playing = false;
  }

  seekFrac(f: number): void {
    this.pt = clamp(f, 0, 1) * this.duration;
  }
  seekTime(t: number): void {
    this.pt = clamp(t, 0, this.duration);
  }
  setSpeed(s: number): void {
    if (s > 0) this.speed = s;
  }
  play(): void {
    if (this.ended) this.pt = 0; // replay from the top
    this.playing = true;
  }
  pause(): void {
    this.playing = false;
  }
  toggle(): void {
    this.playing ? this.pause() : this.play();
  }
  reset(): void {
    this.pt = 0;
    this.playing = true;
  }
}
