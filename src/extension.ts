import * as vscode from "vscode";
import { CoachingPanel } from "./coachingFeed";
import { StreamPanel } from "./streamFeed";
import { CostDetailPanel } from "./costPanel/panel";
import { buildCostPanelState } from "./costPanel/viewModel";
import { CostStatusBar } from "./statusBar";
import { CostFeedController } from "./costFeed";
import { resolveBinary } from "./binary";
import { VisualizerPanel } from "./visualizerPanel";
import { UpdatePromptController } from "./updatePrompt";
import { SessionRestoreController, makeRestoreDeps } from "./sessionRestore";
import { TerminalFocusController, makeTerminalFocusDeps } from "./terminalFocus";

let statusBar: CostStatusBar | undefined;
let costFeed: CostFeedController | undefined;
let terminalFocus: TerminalFocusController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration("promptconduit.cost");
  const resolveCli = () => resolveBinary(cfg().get<string>("binaryPath", ""));

  statusBar = new CostStatusBar();
  context.subscriptions.push(statusBar);

  const updates = new UpdatePromptController(
    context.extension.packageJSON.version as string,
  );
  context.subscriptions.push(updates);
  updates.start();

  const allSessionsButton = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    98,
  );
  allSessionsButton.text = "$(list-tree) All sessions";
  allSessionsButton.tooltip = "Open the multi-session AI cost overview";
  allSessionsButton.command = "promptconduit.cost.showAllSessions";
  allSessionsButton.show();
  context.subscriptions.push(allSessionsButton);

  const streamButton = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99,
  );
  streamButton.text = "$(pulse) Stream";
  streamButton.tooltip = "Open the live PromptConduit event stream";
  streamButton.command = "promptconduit.stream.showFeed";
  streamButton.show();
  context.subscriptions.push(streamButton);

  const panelState = (mode: "session" | "all") =>
    buildCostPanelState(statusBar!.storeRef, mode);

  const refreshPanels = () => {
    CostDetailPanel.refresh();
  };

  statusBar.setOnChange(refreshPanels);

  context.subscriptions.push(
    vscode.commands.registerCommand("promptconduit.cost.showDetails", () => {
      CostDetailPanel.show(context.extensionUri, "session", panelState);
    }),
    vscode.commands.registerCommand("promptconduit.cost.showAllSessions", () => {
      CostDetailPanel.show(context.extensionUri, "all", panelState);
    }),
    vscode.commands.registerCommand("promptconduit.cost.pinSession", () => {
      void statusBar?.pickAndPin();
    }),
    vscode.commands.registerCommand("promptconduit.cost.followActive", () => {
      statusBar?.followActive();
    }),
    vscode.commands.registerCommand("promptconduit.coaching.showTab", () => {
      CoachingPanel.show();
    }),
    vscode.commands.registerCommand("promptconduit.stream.showFeed", () => {
      StreamPanel.show(context.extensionUri);
    }),
    vscode.commands.registerCommand("promptconduit.stream.pinSession", () => {
      const panel = StreamPanel.active;
      if (!panel) {
        StreamPanel.show(context.extensionUri);
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
    vscode.commands.registerCommand("promptconduit.refreshPanel", () => {
      // Reload the focused PromptConduit webview in place — picks up an extension
      // update's rebuilt panel bundle without a full window reload.
      const refreshed = CostDetailPanel.refreshActive() || StreamPanel.refreshActive();
      if (!refreshed) {
        void vscode.window.showInformationMessage(
          "Focus a PromptConduit Stream or Cost Breakdown panel, then run Refresh Panel.",
        );
      }
    }),
  );

  terminalFocus = new TerminalFocusController(
    makeTerminalFocusDeps(resolveCli, (sessionKey) => {
      statusBar?.setFocusedKey(sessionKey);
    }),
  );
  terminalFocus.start();
  context.subscriptions.push(terminalFocus);

  const restore = new SessionRestoreController(
    makeRestoreDeps(context, resolveCli, (term, sessionId) => {
      terminalFocus?.registerTerminal(term, sessionId);
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("promptconduit.restore.sessions", () => {
      void restore.runManual();
    }),
  );
  void restore.runStartup();

  const start = () => {
    stopCostFeed();
    if (!cfg().get<boolean>("enabled", true)) {
      statusBar?.hide();
      return;
    }
    statusBar?.show();
    // No direct refreshPanels here — updateFrom* schedules a throttled render,
    // and render fires onChange → refreshPanels. One path, one repaint.
    costFeed = new CostFeedController({
      onEvent: (ev) => {
        statusBar?.updateFromEvent(ev);
      },
      onEnvelope: (env) => {
        statusBar?.updateFromEnvelope(env);
      },
    });
    costFeed.start();
  };

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
