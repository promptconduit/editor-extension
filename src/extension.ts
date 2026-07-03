import * as vscode from "vscode";
import { CoachingPanel } from "./coachingFeed";
import { StreamPanel } from "./streamFeed";
import { BreakdownView, CostPanel } from "./panel";
import { CostStatusBar } from "./statusBar";
import { CostFeedController } from "./costFeed";
import { resolveBinary } from "./binary";
import { VisualizerPanel } from "./visualizerPanel";
import { UpdatePromptController } from "./updatePrompt";
import { SessionRestoreController, makeRestoreDeps } from "./sessionRestore";

let statusBar: CostStatusBar | undefined;
let costFeed: CostFeedController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration("promptconduit.cost");

  statusBar = new CostStatusBar();
  context.subscriptions.push(statusBar);

  // When the CLI updates this extension on disk after a self-upgrade, offer a
  // one-click **Reload Window** to apply it — a reload keeps the pty host alive,
  // so terminals running Claude Code survive (a full restart would kill them).
  const updates = new UpdatePromptController(
    context.extension.packageJSON.version as string,
  );
  context.subscriptions.push(updates);
  updates.start();

  // Bottom-right status-bar entry point for the Stream panel. Priority 99 seats
  // it just to the right of the cost item (100).
  const streamButton = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99,
  );
  streamButton.text = "$(pulse) Stream";
  streamButton.tooltip = "Open the live PromptConduit event stream";
  streamButton.command = "promptconduit.stream.showFeed";
  streamButton.show();
  context.subscriptions.push(streamButton);

  const breakdownView = (): BreakdownView => ({
    conversations: statusBar?.conversations ?? [],
    activeKey: statusBar?.activeConversationKey,
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("promptconduit.cost.showDetails", () => {
      CostPanel.show(breakdownView());
    }),
    vscode.commands.registerCommand("promptconduit.coaching.showTab", () => {
      CoachingPanel.show();
    }),
    vscode.commands.registerCommand("promptconduit.stream.showFeed", () => {
      StreamPanel.show();
    }),
    vscode.commands.registerCommand("promptconduit.stream.pinSession", () => {
      const panel = StreamPanel.active;
      if (!panel) {
        StreamPanel.show();
        return;
      }
      void panel.pinSession();
    }),
    vscode.commands.registerCommand("promptconduit.stream.followActive", () => {
      StreamPanel.active?.followActive();
    }),
    vscode.commands.registerCommand("promptconduit.visualizer.show", () => {
      VisualizerPanel.show(context.extensionUri);
    }),
  );

  // Bring interrupted AI sessions back to life. On startup this reopens Claude
  // Code sessions that were active before the editor restarted (which kills the
  // terminals) — in the exact directory they ran in, worktrees included — via
  // the CLI engine (`promptconduit sessions --json`). Mode is configurable
  // (auto / prompt / off); a manual command lets the user pick any time.
  const restore = new SessionRestoreController(
    makeRestoreDeps(context, () =>
      resolveBinary(cfg().get<string>("binaryPath", "")),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("promptconduit.restore.sessions", () => {
      void restore.runManual();
    }),
  );
  void restore.runStartup();

  // Cost ingestion: since envelope v2 the per-request costs live on the local
  // event log (enrichments.cost on events.jsonl), so the status bar and the
  // breakdown panel read the same file every other surface does — no CLI
  // subprocess required.
  const start = () => {
    stopCostFeed();
    if (!cfg().get<boolean>("enabled", true)) {
      statusBar?.hide();
      return;
    }
    statusBar?.show();
    costFeed = new CostFeedController({
      onEvent: (ev) => {
        statusBar?.updateFromEvent(ev);
        CostPanel.refresh(breakdownView());
      },
    });
    costFeed.start();
  };

  // React to config changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("promptconduit.cost")) {
        start();
      }
    }),
    { dispose: stopCostFeed },
  );

  start();
}

export function deactivate(): void {
  stopCostFeed();
}

function stopCostFeed(): void {
  if (costFeed) {
    costFeed.dispose();
    costFeed = undefined;
  }
}
