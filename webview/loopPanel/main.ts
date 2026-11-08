// The Loop webview client: mounts renderApp(state), wires the prompt picker,
// links and tooltips, and runs the replay animation. Replays the whole loop
// when a different prompt is shown; while a prompt is live, only new
// round-trips animate in.

import type { HostMessage, LoopPanelState, WebviewCommand, WebviewMessage } from "../../src/loopPanel/protocol";
import { renderApp } from "./render";

declare function acquireVsCodeApi(): { postMessage(msg: WebviewMessage): void };
const vscode = acquireVsCodeApi();
const post = (m: WebviewMessage) => vscode.postMessage(m);
window.addEventListener("error", (e) => post({ type: "log", level: "error", msg: String(e.message) }));

const app = document.getElementById("app") ?? document.body;
const tip = document.createElement("div");
tip.className = "tip";
tip.hidden = true;
document.body.appendChild(tip);

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let state: LoopPanelState | undefined;
let shownPrompt: string | undefined;
let shownCalls = 0;
let animId = 0;

function showTip(ev: MouseEvent, text: string): void {
  tip.textContent = text;
  tip.hidden = false;
  const x = Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  const y = Math.min(ev.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

function render(s: LoopPanelState): void {
  const scroll = app.querySelector<HTMLElement>(".stage .scroll");
  const keepScroll = scroll?.scrollLeft ?? 0;
  app.innerHTML = renderApp(s);
  const newScroll = app.querySelector<HTMLElement>(".stage .scroll");
  if (newScroll) newScroll.scrollLeft = keepScroll;

  const calls = s.ledger?.calls.length ?? 0;
  if (s.selectedPromptId !== shownPrompt) {
    play(0);
  } else if (calls > shownCalls) {
    play(shownCalls);
  }
  shownPrompt = s.selectedPromptId;
  shownCalls = calls;
}

/** Animate columns from index `from` onward; earlier ones render at rest. */
function play(from: number): void {
  const cols = Array.from(app.querySelectorAll<SVGGElement>("#loop .col"));
  const meter = app.querySelector<HTMLElement>("#meter");
  if (reduceMotion || cols.length === 0 || !state?.ledger) return;
  const id = ++animId;
  const per = 520;
  const t0 = performance.now();
  // The meter counts the prompt itself; after-prompt wake-ups have their own note.
  const totals = state.ledger.calls.map((c) => (c.afterPrompt ? 0 : c.usd.total));
  const promptTotal = totals.reduce((a, v) => a + v, 0);
  const before = totals.slice(0, from).reduce((a, v) => a + v, 0);
  const anim = cols.slice(from).map((g) => {
    const rd = g.querySelector<SVGRectElement>(".rd")!;
    const scan = g.querySelector<SVGRectElement>(".scan")!;
    const ex = Array.from(g.querySelectorAll<SVGElement>(".ex"));
    const y = Number(rd.dataset.y);
    const base = Number(rd.dataset.base);
    rd.setAttribute("y", String(base));
    rd.setAttribute("height", "0");
    ex.forEach((e) => (e.style.opacity = "0"));
    return { rd, scan, ex, y, base };
  });
  const finish = () => {
    anim.forEach((a) => {
      a.rd.setAttribute("y", String(a.y));
      a.rd.setAttribute("height", String(a.base - a.y));
      a.scan.setAttribute("height", "0");
      a.ex.forEach((e) => (e.style.opacity = "1"));
    });
    if (meter) meter.textContent = `$${promptTotal.toFixed(2)}`;
  };
  const frame = (now: number) => {
    if (id !== animId) return;
    const t = now - t0;
    let spent = before;
    anim.forEach((a, i) => {
      const p = Math.min(1, Math.max(0, (t - i * per) / (per * 0.8)));
      const e = 1 - Math.pow(1 - p, 3);
      const h = (a.base - a.y) * e;
      a.rd.setAttribute("y", String(a.base - h));
      a.rd.setAttribute("height", String(h));
      a.scan.setAttribute("y", String(a.base - h));
      a.scan.setAttribute("height", p > 0 && p < 1 ? String(Math.min(12, h)) : "0");
      if (p >= 0.85) a.ex.forEach((x) => (x.style.opacity = "1"));
      spent += totals[from + i] * e;
    });
    if (meter) meter.textContent = `$${spent.toFixed(2)}`;
    if (t < anim.length * per + 300) requestAnimationFrame(frame);
    else finish();
  };
  requestAnimationFrame(frame);
  // Animation frames are throttled in hidden panels; always land at rest.
  setTimeout(() => {
    if (id === animId) finish();
  }, anim.length * per + 900);
}

// ---- events (delegated, so they survive re-renders) ----

app.addEventListener("change", (e) => {
  const t = e.target as HTMLElement;
  if (t.id === "pick") post({ type: "selectPrompt", promptId: (t as HTMLSelectElement).value });
});

app.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.id === "latest") post({ type: "command", id: "followLatest" });
  else if (t.id === "replay") play(0);
  const link = t.closest<HTMLElement>("[data-href]");
  if (link) {
    e.preventDefault();
    post({ type: "open_external", url: link.dataset.href! });
  }
  const cmd = t.closest<HTMLElement>("[data-cmd]");
  if (cmd) post({ type: "command", id: cmd.dataset.cmd as WebviewCommand });
  const copy = t.closest<HTMLElement>("[data-copy]");
  if (copy) {
    const text = copy.dataset.copy ?? "";
    void navigator.clipboard?.writeText(text).then(
      () => {
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1500);
      },
      () => post({ type: "log", level: "warn", msg: "clipboard write refused" }),
    );
  }
  if (t.id === "growth-hit" && state?.session) {
    const i = growthIndex(e as MouseEvent, t);
    const ts = state.session.growth[i]?.[0];
    const marks = state.session.promptMarks;
    let owner: string | undefined;
    for (const [mts, pid] of marks) if (mts <= ts) owner = pid;
    if (owner) post({ type: "selectPrompt", promptId: owner });
  }
});

function growthIndex(ev: MouseEvent, hit: HTMLElement): number {
  const svg = hit.closest("svg")!;
  const box = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  const sx = ((ev.clientX - box.left) / box.width) * vb.width;
  const n = Number(hit.dataset.n);
  const l = Number(hit.dataset.l);
  const w = Number(hit.dataset.w);
  return Math.max(0, Math.min(n - 1, Math.round(((sx - l) / w) * (n - 1))));
}

app.addEventListener("mousemove", (e) => {
  const t = e.target as Element;
  const holder = t.closest<HTMLElement | SVGElement>("[data-tip]");
  if (holder) {
    showTip(e, (holder as HTMLElement).dataset.tip ?? "");
    return;
  }
  if ((t as HTMLElement).id === "growth-hit" && state?.session) {
    const p = state.session.growth[growthIndex(e, t as HTMLElement)];
    if (p) {
      const d = new Date(p[0]).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      showTip(e, `${d}\ncontext ${Math.round(p[1]).toLocaleString("en-US")} tok · call $${p[2].toFixed(3)}\nclick to open this prompt`);
      return;
    }
  }
  tip.hidden = true;
});
app.addEventListener("mouseleave", () => (tip.hidden = true));

window.addEventListener("message", (ev: MessageEvent<HostMessage>) => {
  const msg = ev.data;
  if (msg?.type === "state") {
    state = msg.state;
    render(msg.state);
  }
});

post({ type: "ready" });
