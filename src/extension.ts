import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { CoachingPanel } from "./coachingFeed";
import { StreamPanel } from "./streamFeed";
import { GraphPanel } from "./graphPanel/panel";
import { CostDetailPanel } from "./costPanel/panel";
import { buildCostPanelState } from "./costPanel/viewModel";
import { CostStatusBar } from "./statusBar";
import { CostFeedController } from "./costFeed";
import { resolveBinary } from "./binary";
import { VisualizerPanel } from "./visualizerPanel";
import { UpdatePromptController } from "./updatePrompt";
import { SessionRestoreController, makeRestoreDeps, recordDismissed } from "./sessionRestore";
import { TerminalFocusController, makeTerminalFocusDeps } from "./terminalFocus";
import { CursorTabTracker, runComposerQuery } from "./cursorTabs";

let statusBar: CostStatusBar | undefined;
let costFeed: CostFeedController | undefined;
let terminalFocus: TerminalFocusController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  try {
    activateInner(context);
  } catch (err) {
    // A thrown activation must never silently leave the extension half-wired —
    // e.g. status-bar items whose command never got registered, so clicking
    // them does nothing. Surface it instead of failing quietly.
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    const channel = vscode.window.createOutputChannel("PromptConduit");
    channel.appendLine(`Activation failed: ${detail}`);
    context.subscriptions.push(channel);
    void vscode.window.showErrorMessage(
      `PromptConduit failed to activate: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function activateInner(context: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration("promptconduit.cost");
  const resolveCli = () => resolveBinary(cfg().get<string>("binaryPath", ""));

  statusBar = new CostStatusBar();
  context.subscriptions.push(statusBar);

  const panelState = (mode: "session" | "all") =>
    buildCostPanelState(statusBar!.storeRef, mode);

  statusBar.setOnChange(() => CostDetailPanel.refresh());

  // Selection gestures (a focused terminal, a selected Cursor agent tab) latch
  // the status bar AND — when followSelection is on — drill an open Stream
  // panel into that session. Event recency still never moves the stream. The
  // last gesture is remembered so a Stream panel opened AFTER the gesture
  // starts on the selected session.
  const followSelection = () =>
    vscode.workspace
      .getConfiguration("promptconduit.stream")
      .get<boolean>("followSelection", true);
  let lastSelection: { key: string; source: "terminal" | "cursor-tab" } | undefined;
  const followStream = (key: string, source: "terminal" | "cursor-tab") => {
    lastSelection = { key, source };
    if (followSelection()) {
      StreamPanel.active?.selectSession(key, source);
    }
  };

  // Register every command BEFORE anything below that could throw, so a later
  // failure can't leave a status-bar item pointing at an unregistered command
  // (which is exactly what makes a click appear to do nothing).
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
      // A panel opened after the gesture still lands on the selected session.
      if (lastSelection && followSelection()) {
        StreamPanel.active?.selectSession(lastSelection.key, lastSelection.source);
      }
    }),
    vscode.commands.registerCommand("promptconduit.stream.drillIn", () => {
      const panel = StreamPanel.active;
      if (!panel) {
        StreamPanel.show(context.extensionUri);
        return;
      }
      void panel.drillIntoSession();
    }),
    vscode.commands.registerCommand("promptconduit.stream.showAll", () => {
      StreamPanel.active?.showAll();
    }),
    vscode.commands.registerCommand("promptconduit.visualizer.show", () => {
      VisualizerPanel.show(context.extensionUri);
    }),
    vscode.commands.registerCommand("promptconduit.graph.show", () => {
      GraphPanel.show(context.extensionUri);
    }),
    vscode.commands.registerCommand("promptconduit.refreshPanel", () => {
      // Reload the focused PromptConduit webview in place — picks up an extension
      // update's rebuilt panel bundle without a full window reload.
      const refreshed =
        CostDetailPanel.refreshActive() || StreamPanel.refreshActive() || GraphPanel.refreshActive();
      if (!refreshed) {
        void vscode.window.showInformationMessage(
          "Focus a PromptConduit Stream, Session Graph, or Cost Breakdown panel, then run Refresh Panel.",
        );
      }
    }),
  );

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

  const graphButton = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    97,
  );
  graphButton.text = "$(type-hierarchy-sub) Graph";
  graphButton.tooltip = "Open the live session graph — prompts, tools, subagents, worktrees";
  graphButton.command = "promptconduit.graph.show";
  graphButton.show();
  context.subscriptions.push(graphButton);

  terminalFocus = new TerminalFocusController(
    makeTerminalFocusDeps(
      resolveCli,
      (sessionKey) => {
        statusBar?.setFocusedKey(sessionKey);
        if (sessionKey) {
          followStream(sessionKey, "terminal");
        }
      },
      // Deliberately closing a Claude terminal dismisses that session so a later
      // window reload won't auto-reopen it. Reload teardown is guarded in
      // deactivate() via markShuttingDown().
      (sessionId) => recordDismissed(context.workspaceState, sessionId, Date.now()),
    ),
  );
  terminalFocus.start();
  context.subscriptions.push(terminalFocus);

  // Cursor-only, best-effort: the focused agent tab is not observable through
  // any extension API, so read Cursor's own workspace-storage record of it
  // (ItemTable key composer.composerData → lastFocusedComposerIds[0], which is
  // the conversation_id our events are keyed by). Read-only via the sqlite3
  // CLI; self-disables on repeated failure (missing sqlite3, schema change)
  // without affecting the terminal/prompt signals.
  const isCursor = vscode.env.appName.toLowerCase().includes("cursor");
  const cursorTabsEnabled = vscode.workspace
    .getConfiguration("promptconduit.cursorTabs")
    .get<boolean>("enabled", true);
  if (isCursor && cursorTabsEnabled) {
    const storageDir = context.storageUri?.fsPath;
    const workspaceDb = storageDir ? path.join(path.dirname(storageDir), "state.vscdb") : undefined;
    const tracker = new CursorTabTracker({
      dbPath: () => (workspaceDb && fs.existsSync(workspaceDb) ? workspaceDb : null),
      query: runComposerQuery,
      onFocusedComposer: (composerId) => {
        statusBar?.setCursorTabKey(composerId);
        if (composerId) {
          followStream(composerId, "cursor-tab");
        }
      },
      onDisabled: (reason) => {
        console.warn(`PromptConduit: Cursor agent-tab tracking disabled (${reason})`);
      },
    });
    tracker.start();
    context.subscriptions.push(tracker);
  }

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
  // A window reload tears down every terminal; mark shutdown first so those
  // closes aren't recorded as deliberate user dismissals (which would stop
  // restore from reopening them on the next load).
  terminalFocus?.markShuttingDown();
  stopCostFeed();
}

function stopCostFeed(): void {
  if (costFeed) {
    costFeed.dispose();
    costFeed = undefined;
  }
}
