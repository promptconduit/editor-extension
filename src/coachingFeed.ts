import * as vscode from "vscode";
import { RawEventTail, logDisabled } from "./tail";
import {
  ParsedEvent,
  parseEnvelopeLine,
  reduceToSnapshot,
  reduceToTrends,
} from "./coaching/derive";
import { buildCoachingInsights } from "./coaching/insights";
import { renderCoachingHtml } from "./coaching/render";

// Bound the in-memory event buffer. ~60k events is far more than any single
// machine's local history within the log's rotation window, and trimming the
// front keeps the newest (the log is append-only / time-ordered).
const MAX_EVENTS = 60_000;
const RENDER_THROTTLE_MS = 300;

/**
 * CoachingController owns the bounded full-history read + live tail of
 * events.jsonl, derives the coaching report locally (offline-first), and pushes
 * finished HTML to a sink. Host-agnostic: the same logic backs the docked
 * Coaching webview and could back any other host. Server-rendered
 * (enableScripts:false) with a render throttle to coalesce bursty appends.
 */
export class CoachingController {
  private readonly tail: RawEventTail;
  private events: ParsedEvent[] = [];
  private disposed = false;
  private pending = false;
  private throttle: NodeJS.Timeout | undefined;
  private gotInitial = false;

  constructor(private readonly setHtml: (html: string) => void) {
    this.tail = new RawEventTail({ onLines: (lines, initial) => this.ingest(lines, initial) });
  }

  start(): void {
    this.render(); // paint empty/disabled state immediately
    if (!logDisabled()) {
      this.tail.start();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.tail.dispose();
    if (this.throttle) {
      clearTimeout(this.throttle);
      this.throttle = undefined;
    }
  }

  private ingest(lines: string[], initial: boolean): void {
    for (const line of lines) {
      const ev = parseEnvelopeLine(line);
      if (ev) {
        this.events.push(ev);
      }
    }
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    if (initial) {
      this.gotInitial = true;
      this.render(); // render the full history immediately, unthrottled
    } else {
      this.scheduleRender();
    }
  }

  private scheduleRender(): void {
    if (this.throttle) {
      this.pending = true;
      return;
    }
    this.render();
    this.throttle = setTimeout(() => {
      this.throttle = undefined;
      if (this.pending) {
        this.pending = false;
        this.render();
      }
    }, RENDER_THROTTLE_MS);
  }

  private render(): void {
    if (this.disposed) {
      return;
    }
    this.setHtml(this.buildHtml());
  }

  // Pure assembly: live snapshot + all-local-history trends → HTML. Insights come
  // from the live session; if it's too small to flag anything yet, fall back to
  // the user's overall history so coaching is always present once there's data.
  private buildHtml(): string {
    if (logDisabled()) {
      return renderCoachingHtml(undefined);
    }
    const snapshot = reduceToSnapshot(this.events);
    const trends = reduceToTrends(this.events, 0);
    if (snapshot) {
      snapshot.insights = buildCoachingInsights(snapshot.metrics);
      if (snapshot.insights.length === 0 && trends.metrics.prompts >= 8) {
        snapshot.insights = buildCoachingInsights(trends.metrics);
      }
    }
    const showTrends = trends.daily.length > 1 ? trends : undefined;
    return renderCoachingHtml(snapshot, showTrends);
  }
}

/**
 * Hosts the coaching report as a docked WebviewView in the bottom panel,
 * alongside the Telemetry view (both under the "PromptConduit" container). One
 * CoachingController per resolved view, torn down when the view is disposed.
 */
export class CoachingViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = "promptconduit.coaching";
  private controller: CoachingController | undefined;

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: false };
    this.controller?.dispose();
    const controller = new CoachingController((html) => {
      view.webview.html = html;
    });
    this.controller = controller;
    view.onDidDispose(() => {
      controller.dispose();
      if (this.controller === controller) {
        this.controller = undefined;
      }
    });
    controller.start();
  }

  dispose(): void {
    this.controller?.dispose();
    this.controller = undefined;
  }
}
