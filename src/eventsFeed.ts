import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

// The stable local substrate the CLI writes: one envelope per line, rotating to
// events.jsonl.1 at ~50MB. See cli/internal/eventlog and envelope.RawEventEnvelope.
const EVENTS_DIR = ".promptconduit";
const EVENTS_FILE = "events.jsonl";

// Keep memory bounded — we only ever render the tail.
const MAX_EVENTS = 200;
// Match statusBar.ts: coalesce bursty appends into one render per window.
const RENDER_THROTTLE_MS = 250;
// Fallback poll cadence for environments where fs.watch is unreliable.
const POLL_INTERVAL_MS = 1000;

function eventsPath(): string {
  return path.join(os.homedir(), EVENTS_DIR, EVENTS_FILE);
}

/** True when the user disabled the local event log via the CLI's env switch. */
function logDisabled(): boolean {
  return process.env.PROMPTCONDUIT_EVENT_LOG === "0";
}

/** The subset of envelope fields the feed renders. */
interface FeedEvent {
  tool: string;
  hookEvent: string;
  capturedAt: string;
  repo: string;
  branch: string;
}

// Parse one JSONL line into a FeedEvent. Returns null for blanks, malformed
// JSON, or non-object lines so a single bad line never breaks the feed.
function parseLine(line: string): FeedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) {
    return null;
  }
  const rec = obj as {
    tool?: unknown;
    hook_event?: unknown;
    captured_at?: unknown;
    enrichment?: { git?: { repo_name?: unknown; branch?: unknown } };
    git?: { repo_name?: unknown; branch?: unknown };
  };
  // Prefer enrichment.git; fall back to the deprecated top-level mirror.
  const git = rec.enrichment?.git ?? rec.git ?? {};
  return {
    tool: str(rec.tool),
    hookEvent: str(rec.hook_event),
    capturedAt: str(rec.captured_at),
    repo: str(git.repo_name),
    branch: str(git.branch),
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Tails ~/.promptconduit/events.jsonl, reading only appended bytes. Detects
 * truncation/rotation (size shrank or inode changed) and re-reads from the
 * start so the feed survives the file rolling over to events.jsonl.1.
 */
class EventsTail {
  private offset = 0;
  private size = 0;
  private inode = 0;
  private carry = ""; // partial trailing line spanning two reads
  private watcher: fs.FSWatcher | undefined;
  private poll: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly file: string,
    private readonly onEvents: (events: FeedEvent[]) => void,
  ) {}

  start(): void {
    // Seed with whatever already exists, then watch for growth.
    this.readNew();
    this.watchDir();
    // Poll as a safety net: fs.watch misses some editors/FS combinations.
    this.poll = setInterval(() => this.readNew(), POLL_INTERVAL_MS);
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

  // Watch the parent directory rather than the file: the file may not exist
  // yet, and watching a dir survives the rotation that replaces the inode.
  private watchDir(): void {
    const dir = path.dirname(this.file);
    const base = path.basename(this.file);
    try {
      this.watcher = fs.watch(dir, (_event, filename) => {
        if (!filename || filename === base) {
          this.readNew();
        }
      });
      this.watcher.on("error", () => {
        // Polling keeps us alive; drop the watcher rather than throw.
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      // Directory missing or unwatchable — the poll loop still covers us.
    }
  }

  private readNew(): void {
    if (this.disposed) {
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
    } catch {
      // File gone (not created yet, or deleted): reset so a fresh file is
      // read from the top once it reappears.
      this.reset();
      return;
    }

    // Rotation/truncation: smaller size or a new inode means the old offset is
    // meaningless. Re-read from the beginning.
    if (stat.size < this.offset || (this.inode && stat.ino !== this.inode)) {
      this.reset();
    }
    this.inode = stat.ino;
    this.size = stat.size;

    if (stat.size <= this.offset) {
      return; // nothing appended
    }

    let chunk: string;
    try {
      const fd = fs.openSync(this.file, "r");
      try {
        const len = stat.size - this.offset;
        const buf = Buffer.allocUnsafe(len);
        const read = fs.readSync(fd, buf, 0, len, this.offset);
        chunk = buf.toString("utf8", 0, read);
        this.offset += read;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }

    const text = this.carry + chunk;
    const lines = text.split("\n");
    // Last element is an incomplete line (no trailing newline yet) — carry it.
    this.carry = lines.pop() ?? "";

    const events: FeedEvent[] = [];
    for (const line of lines) {
      const ev = parseLine(line);
      if (ev) {
        events.push(ev);
      }
    }
    if (events.length > 0) {
      this.onEvents(events);
    }
  }

  private reset(): void {
    this.offset = 0;
    this.size = 0;
    this.inode = 0;
    this.carry = "";
  }
}

/**
 * EventsFeedPanel renders a live, scrolling view of the local events.jsonl
 * substrate. A single reused webview (mirrors CostPanel): enableScripts:false,
 * server-rendered HTML, re-rendered on new events with a 250ms throttle.
 */
export class EventsFeedPanel {
  private static current: EventsFeedPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly tail: EventsTail;
  private readonly events: FeedEvent[] = [];
  private disposed = false;
  private pending = false;
  private throttle: NodeJS.Timeout | undefined;

  static show(): void {
    if (EventsFeedPanel.current && !EventsFeedPanel.current.disposed) {
      EventsFeedPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "promptconduitEventsFeed",
      "AI Events Feed",
      vscode.ViewColumn.Active,
      { enableScripts: false, retainContextWhenHidden: true },
    );
    EventsFeedPanel.current = new EventsFeedPanel(panel);
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.tail.dispose();
      if (this.throttle) {
        clearTimeout(this.throttle);
        this.throttle = undefined;
      }
      if (EventsFeedPanel.current === this) {
        EventsFeedPanel.current = undefined;
      }
    });

    this.tail = new EventsTail(eventsPath(), (events) => this.ingest(events));
    this.render(); // paint the empty / disabled state immediately
    if (!logDisabled()) {
      this.tail.start();
    }
  }

  // Append new events, trim to the bounded buffer, and schedule a render.
  private ingest(events: FeedEvent[]): void {
    this.events.push(...events);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    this.scheduleRender();
  }

  // Throttle identical to statusBar.ts: render now, then coalesce a single
  // trailing render if more events arrive inside the window.
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
    this.panel.webview.html = this.html();
  }

  private html(): string {
    // Newest first.
    const rows = this.events
      .slice()
      .reverse()
      .map((e) => {
        const repo = e.repo
          ? escape(e.branch ? `${e.repo} (${e.branch})` : e.repo)
          : '<span class="muted">—</span>';
        return `
        <tr>
          <td class="time">${escape(fmtTime(e.capturedAt))}</td>
          <td><span class="tool">${escape(e.tool || "—")}</span></td>
          <td><span class="hook">${escape(e.hookEvent || "—")}</span></td>
          <td>${repo}</td>
        </tr>`;
      })
      .join("");

    const body = this.events.length > 0 ? this.tableHtml(rows) : this.emptyHtml();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); padding: 1rem 1.25rem; }
  h1 { font-size: 1.1rem; margin: 0 0 0.25rem; }
  .muted { color: var(--vscode-descriptionForeground); }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; }
  td.time, th.time { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .tool, .hook { display: inline-block; font-size: 0.78rem; padding: 0.1rem 0.5rem; border-radius: 0.5rem;
                 background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .empty { margin-top: 1.5rem; }
  code { background: var(--vscode-textCodeBlock-background); padding: 0.1rem 0.35rem; border-radius: 0.35rem; }
  footer { margin-top: 1.5rem; }
</style>
</head>
<body>
  <h1>AI Events Feed <span class="muted">(${this.events.length} recent)</span></h1>
  <p class="muted">Live tail of <code>~/.promptconduit/events.jsonl</code> — newest first.</p>
  ${body}
  <footer class="muted">
    Read straight from the local log on your machine. None of your data is sent anywhere.
  </footer>
</body>
</html>`;
  }

  private tableHtml(rows: string): string {
    return `<table>
    <thead>
      <tr>
        <th class="time">Time</th><th>Tool</th><th>Event</th><th>Repo</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>`;
  }

  private emptyHtml(): string {
    if (logDisabled()) {
      return `<div class="empty muted">
    <p>The local event log is <strong>disabled</strong> (<code>PROMPTCONDUIT_EVENT_LOG=0</code>).</p>
    <p>Unset that variable and restart your AI tool to start capturing events, then reopen this view.</p>
  </div>`;
    }
    return `<div class="empty muted">
    <p>No events yet. Run an AI coding session (e.g. Claude Code) with the
    <code>promptconduit</code> CLI hooks installed and events will stream in here within ~1s.</p>
    <p>Waiting on <code>~/.promptconduit/events.jsonl</code>…</p>
  </div>`;
  }
}

// Render the ISO8601 captured_at as a local HH:MM:SS; fall back to the raw
// string if it isn't parseable so we never hide an event.
function fmtTime(iso: string): string {
  if (!iso) {
    return "—";
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleTimeString();
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
