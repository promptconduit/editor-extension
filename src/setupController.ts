// Tracks the first-run setup step (CLI missing → run init → ready) and offers
// the install/init commands in a terminal. Probes are a few stat calls; they
// repeat only until setup is complete, then stop for good.

import * as fs from "fs";
import * as vscode from "vscode";
import { locateBinary } from "./binary";
import { logDisabled, eventsJsonlPath, rotatedJsonlPath } from "./tail";
import { SetupStep, setupStep, setupState, SetupState } from "./setup";
import { installCommand } from "./optionalFeatures";
import { shellQuote } from "./syncOffer";

const RECHECK_MS = 10_000;

export class SetupController implements vscode.Disposable {
  private step: SetupStep;
  private onChange: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly configuredPath: () => string) {
    this.step = this.probe();
  }

  current(): SetupStep {
    return this.step;
  }

  /** Webview card state, or undefined once setup is done. */
  state(): SetupState | undefined {
    return setupState(this.step, process.platform, installCommand());
  }

  /** The located CLI, or null when it isn't installed. */
  cli(): string | null {
    return locateBinary(this.configuredPath());
  }

  setOnChange(fn: () => void): void {
    this.onChange = fn;
  }

  start(): void {
    if (this.step === "ready") {
      return;
    }
    this.timer = setInterval(() => this.recheck(), RECHECK_MS);
    this.disposables.push(
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) {
          this.recheck();
        }
      }),
      // The installer and `init` run in a terminal; re-probe the moment it exits.
      vscode.window.onDidCloseTerminal(() => this.recheck()),
    );
  }

  recheck(): void {
    const next = this.probe();
    if (next === this.step) {
      return;
    }
    this.step = next;
    if (next === "ready") {
      this.stop();
    }
    this.onChange?.();
  }

  /**
   * Run the curl installer in a terminal (it starts `promptconduit init` itself),
   * or open the install docs where there's no one-click installer (Windows, the
   * VS Code Marketplace package).
   */
  installCli(): void {
    const command = process.platform === "win32" ? undefined : installCommand();
    if (!command) {
      void vscode.env.openExternal(vscode.Uri.parse(setupState("install-cli", "win32")!.docsUrl));
      return;
    }
    const term = vscode.window.createTerminal({ name: "PromptConduit setup" });
    term.show();
    term.sendText(command);
  }

  /** Run `promptconduit init` in a terminal. */
  runInit(): void {
    const bin = this.cli();
    if (!bin) {
      this.offerInstall("then run promptconduit init");
      return;
    }
    const term = vscode.window.createTerminal({ name: "PromptConduit setup" });
    term.show();
    term.sendText(`${shellQuote(bin)} init`);
  }

  /**
   * Resolve the CLI for a command that needs it, or tell the user how to
   * install it. Falls back to the bare name when data is already flowing (the
   * CLI exists, just somewhere we didn't look).
   */
  requireCli(then: string): string | null {
    const bin = this.cli();
    if (bin) {
      return bin;
    }
    if (!this.configuredPath() && this.probe() === "ready") {
      return "promptconduit";
    }
    this.offerInstall(then);
    return null;
  }

  private offerInstall(then: string): void {
    const INSTALL = "Install CLI";
    void vscode.window
      .showErrorMessage(`The PromptConduit CLI isn't installed. Install it, ${then}.`, INSTALL)
      .then((pick) => {
        if (pick === INSTALL) {
          this.installCli();
        }
      });
  }

  private probe(): SetupStep {
    return setupStep({
      cliFound: locateBinary(this.configuredPath()) !== null,
      eventLogExists: fs.existsSync(eventsJsonlPath()) || fs.existsSync(rotatedJsonlPath()),
      logDisabled: logDisabled(),
    });
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  dispose(): void {
    this.stop();
  }
}
