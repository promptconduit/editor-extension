import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { sendFeedback } from "./feedback";
import { LoopPanel } from "./loopPanel/panel";
import { buildLoopPanelState, type LoopSelection } from "./loopPanel/viewModel";
import { CostStatusBar } from "./statusBar";
import { CostFeedController } from "./costFeed";
import { resolveBinary } from "./binary";
import { UpdatePromptController } from "./updatePrompt";
import { SessionRestoreController, makeRestoreDeps, recordDismissed } from "./sessionRestore";
import { TerminalFocusController, makeTerminalFocusDeps } from "./terminalFocus";
import { CursorTabTracker, runComposerQuery } from "./cursorTabs";
import { SyncOfferController, shellQuote } from "./syncOffer";
import { readPublishedRateCard } from "./rateCard";
import { applyRateCard } from "./pricing";
import { readCloudSyncEnabled } from "./cloudAccount";
import { AgentHintController, agentTooltipLine } from "./agentHint";
import { SetupController } from "./setupController";

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

  // First run: until the CLI is installed and has recorded something, the
  // status bar and the empty Loop panel say exactly what to run.
  const setup = new SetupController(() => cfg().get<string>("binaryPath", ""));
  context.subscriptions.push(setup);
  statusBar.setSetupStep(setup.current());
  setup.setOnChange(() => {
    statusBar?.setSetupStep(setup.current());
    LoopPanel.refresh();
    void agentHints.refresh(); // `mcp status` works now that the CLI exists
  });

  const syncOffers = new SyncOfferController(context);
  context.subscriptions.push({ dispose: () => syncOffers.dispose() });
  syncOffers.setOnChange(() => statusBar?.setSyncOffer(syncOffers.current()));
  syncOffers.start();

  const agentHints = new AgentHintController(context, resolveCli);
  context.subscriptions.push({ dispose: () => agentHints.dispose() });
  agentHints.setOnChange(() => {
    statusBar?.setAgentLine(agentTooltipLine(agentHints.current()));
    LoopPanel.refresh();
  });

  const panelState = (sel: LoopSelection) => {
    // The published rate card (when newer than the bundled table) prices the
    // what-if re-pricings; readPublishedRateCard only re-reads a changed file.
    applyRateCard(readPublishedRateCard());
    return buildLoopPanelState(statusBar!.storeRef, sel, syncOffers.current(), {
      signedIn: readCloudSyncEnabled(),
      agentHint: agentHints.current(),
      setup: setup.state(),
    });
  };

  // The panel shows the status bar's displayed session. When that session
  // changes (a focused terminal, a selected Cursor agent tab, a new prompt),
  // the panel goes back to following its newest prompt.
  let shownKey: string | undefined;
  statusBar.setOnChange(() => {
    const key = statusBar!.storeRef.displayKey;
    if (key !== shownKey) {
      shownKey = key;
      LoopPanel.followLatest();
    } else {
      LoopPanel.refresh();
    }
  });
  // Register every command BEFORE anything below that could throw, so a later
  // failure can't leave a status-bar item pointing at an unregistered command
  // (which is exactly what makes a click appear to do nothing).
  context.subscriptions.push(
    vscode.commands.registerCommand("promptconduit.cost.showDetails", () => {
      LoopPanel.show(context.extensionUri, panelState);
    }),
    vscode.commands.registerCommand("promptconduit.cost.pinSession", () => {
      void statusBar?.pickAndPin();
    }),
    vscode.commands.registerCommand("promptconduit.cost.followActive", () => {
      statusBar?.followActive();
    }),
    vscode.commands.registerCommand("promptconduit.setup.installCli", () => {
      setup.installCli();
    }),
    vscode.commands.registerCommand("promptconduit.setup.runInit", () => {
      setup.runInit();
    }),
    vscode.commands.registerCommand("promptconduit.account.login", () => {
      const bin = setup.requireCli("then run promptconduit login");
      if (!bin) {
        return;
      }
      const term = vscode.window.createTerminal({ name: "PromptConduit login" });
      term.show();
      term.sendText(`${shellQuote(bin)} login`);
    }),
    vscode.commands.registerCommand("promptconduit.account.dismissLogin", () => {
      syncOffers.dismiss();
    }),
    vscode.commands.registerCommand("promptconduit.agent.registerMcp", () => {
      void agentHints.register();
    }),
    vscode.commands.registerCommand("promptconduit.agent.dismissHint", () => {
      agentHints.dismiss();
    }),
    vscode.commands.registerCommand("promptconduit.team.invite", async () => {
      const bin = setup.requireCli("then run promptconduit login and invite again");
      if (!bin) {
        return;
      }
      const email = await vscode.window.showInputBox({
        title: "Invite a teammate to your PromptConduit team",
        prompt: "They get a link to join and see the team's AI spend. Needs promptconduit login.",
        placeHolder: "teammate@company.com",
        validateInput: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? undefined : "Enter an email address"),
      });
      if (!email) {
        return;
      }
      const term = vscode.window.createTerminal({ name: "PromptConduit invite" });
      term.show();
      term.sendText(`${shellQuote(bin)} team invite ${shellQuote(email.trim())}`);
    }),
    vscode.commands.registerCommand("promptconduit.feedback.send", () => {
      void sendFeedback(context.extension.packageJSON.version as string);
    }),
    vscode.commands.registerCommand("promptconduit.refreshPanel", () => {
      // Reload the focused PromptConduit webview in place — picks up an extension
      // update's rebuilt panel bundle without a full window reload.
      if (!LoopPanel.refreshActive()) {
        void vscode.window.showInformationMessage("Focus The Loop panel, then run Refresh Panel.");
      }
    }),
  );

  agentHints.start();
  setup.start();

  const updates = new UpdatePromptController(
    context.extension.packageJSON.version as string,
  );
  context.subscriptions.push(updates);
  updates.start();

  terminalFocus = new TerminalFocusController(
    makeTerminalFocusDeps(
      resolveCli,
      (sessionKey) => {
        statusBar?.setFocusedKey(sessionKey);
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
      },
      onDisabled: (reason) => {
        console.warn(`PromptConduit: Cursor agent-tab tracking disabled (${reason})`);
      },
    });
    // No sqlite3 polling while this window is in the background (many windows
    // open = many pollers); a focused window polls immediately on return.
    tracker.setFocused(vscode.window.state.focused);
    tracker.start();
    context.subscriptions.push(
      tracker,
      vscode.window.onDidChangeWindowState((s) => tracker.setFocused(s.focused)),
    );
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
