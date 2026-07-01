import * as vscode from "vscode";
import { CoachingViewProvider } from "./coachingFeed";
import { EventsFeedViewProvider } from "./eventsFeed";
import { StreamViewProvider } from "./streamFeed";
import { CostPanel } from "./panel";
import { CostStatusBar } from "./statusBar";
import { CostWatcher, resolveBinary } from "./watcher";
import { VisualizerPanel } from "./visualizerPanel";

let statusBar: CostStatusBar | undefined;
let watcher: CostWatcher | undefined;
let missingBinaryWarned = false;

export function activate(context: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration("promptconduit.cost");

  statusBar = new CostStatusBar();
  context.subscriptions.push(statusBar);

  // Docked telemetry panel (WebviewView) in Cursor's bottom panel — a live tail
  // of ~/.promptconduit/events.jsonl.
  const telemetry = new EventsFeedViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(EventsFeedViewProvider.viewId, telemetry, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    telemetry,
  );

  // Docked coaching panel (WebviewView) next to Telemetry — a fully offline
  // agent-skills report derived from the local event log.
  const coaching = new CoachingViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CoachingViewProvider.viewId, coaching, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    coaching,
  );

  // Docked live Stream panel (WebviewView) — a per-session tail of
  // ~/.promptconduit/events.jsonl that auto-follows the most recently active AI
  // session (Cursor agent tab / Claude Code), with a manual pin to lock onto one.
  const stream = new StreamViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(StreamViewProvider.viewId, stream, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    stream,
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("promptconduit.cost.showDetails", () => {
      CostPanel.show(statusBar?.session, statusBar?.lastRequest, statusBar?.recentRequests);
    }),
    vscode.commands.registerCommand("promptconduit.events.showFeed", () => {
      // Reveal/focus the docked telemetry panel (auto-registered <viewId>.focus).
      void vscode.commands.executeCommand(`${EventsFeedViewProvider.viewId}.focus`);
    }),
    vscode.commands.registerCommand("promptconduit.coaching.showTab", () => {
      void vscode.commands.executeCommand(`${CoachingViewProvider.viewId}.focus`);
    }),
    vscode.commands.registerCommand("promptconduit.stream.showFeed", () => {
      // Reveal/focus the docked Stream panel (auto-registered <viewId>.focus).
      void vscode.commands.executeCommand(`${StreamViewProvider.viewId}.focus`);
    }),
    vscode.commands.registerCommand("promptconduit.stream.pinSession", () => {
      void stream.pinSession();
    }),
    vscode.commands.registerCommand("promptconduit.stream.followActive", () => {
      stream.followActive();
    }),
    vscode.commands.registerCommand("promptconduit.visualizer.show", () => {
      VisualizerPanel.show(context.extensionUri);
    }),
  );

  const start = () => {
    stopWatcher();
    if (!cfg().get<boolean>("enabled", true)) {
      statusBar?.hide();
      return;
    }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) {
      // No folder open — nothing to scope to; hide until one is.
      statusBar?.hide();
      return;
    }
    const binary = resolveBinary(cfg().get<string>("binaryPath", ""));
    if (!binary) {
      warnMissingBinary();
      statusBar?.hide();
      return;
    }
    statusBar?.show();
    watcher = new CostWatcher(binary, cwd, {
      onRecord: (rec) => {
        if (rec.kind === "cost_event") {
          statusBar?.updateFromEvent(rec);
        } else {
          statusBar?.updateFromSummary(rec);
        }
        CostPanel.refresh(statusBar?.session, statusBar?.lastRequest, statusBar?.recentRequests);
      },
      onError: (msg) => console.error(`[promptconduit] ${msg}`),
    });
    watcher.start();
  };

  // React to config changes and to the user opening a different folder.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("promptconduit.cost")) {
        start();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => start()),
    { dispose: stopWatcher },
  );

  start();
}

export function deactivate(): void {
  stopWatcher();
}

function stopWatcher(): void {
  if (watcher) {
    watcher.stop();
    watcher = undefined;
  }
}

function warnMissingBinary(): void {
  if (missingBinaryWarned) {
    return;
  }
  missingBinaryWarned = true;
  void vscode.window
    .showWarningMessage(
      "PromptConduit cost: the `promptconduit` CLI wasn't found. Install it to see realtime cost.",
      "Copy install command",
    )
    .then((choice) => {
      if (choice === "Copy install command") {
        void vscode.env.clipboard.writeText("brew install promptconduit/tap/promptconduit");
      }
    });
}
