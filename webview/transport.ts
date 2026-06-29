// The transport bar (DOM, styled by the panel's nonce'd CSS): play/pause, a
// scrubber, speed presets, time readout, and a "live" pill (lit only in a future
// live mode). Drives the shared PlaybackClock; update() reflects clock state.
import type { PlaybackClock } from "../src/visualizer/schedule";

const SPEEDS = [0.5, 1, 2, 4];

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export class Transport {
  private el: HTMLElement;
  private playBtn: HTMLButtonElement;
  private scrub: HTMLInputElement;
  private timeEl: HTMLElement;
  private speedBtns: HTMLButtonElement[] = [];
  private dragging = false;

  constructor(
    private readonly clock: PlaybackClock,
    live: boolean,
  ) {
    this.el = document.getElementById("transport")!;
    this.el.replaceChildren();

    this.playBtn = button("play", "⏸");
    this.playBtn.addEventListener("click", () => this.clock.toggle());
    this.el.appendChild(this.playBtn);

    this.scrub = document.createElement("input");
    this.scrub.type = "range";
    this.scrub.min = "0";
    this.scrub.max = "1000";
    this.scrub.value = "0";
    this.scrub.className = "scrub";
    this.scrub.addEventListener("input", () => {
      this.dragging = true;
      this.clock.seekFrac(Number(this.scrub.value) / 1000);
    });
    this.scrub.addEventListener("change", () => {
      this.dragging = false;
    });
    this.el.appendChild(this.scrub);

    this.timeEl = document.createElement("span");
    this.timeEl.className = "time";
    this.el.appendChild(this.timeEl);

    for (const s of SPEEDS) {
      const b = button("speed", `${s}×`);
      b.addEventListener("click", () => {
        this.clock.setSpeed(s);
        this.markSpeed(s);
      });
      this.speedBtns.push(b);
      this.el.appendChild(b);
    }
    this.markSpeed(this.clock.speed);

    const pill = document.createElement("span");
    pill.className = live ? "live" : "live off";
    pill.textContent = live ? "● LIVE" : "● PLAYBACK";
    this.el.appendChild(pill);

    this.el.classList.remove("hidden");
  }

  update(): void {
    this.playBtn.textContent = this.clock.playing ? "⏸" : "▶";
    if (!this.dragging) this.scrub.value = String(Math.round(this.clock.progress * 1000));
    this.timeEl.textContent = `${fmt(this.clock.time)} / ${fmt(this.clock.duration)}`;
  }

  private markSpeed(s: number): void {
    this.speedBtns.forEach((b, i) => b.classList.toggle("active", SPEEDS[i] === s));
  }
}

function button(cls: string, label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = label;
  return b;
}
