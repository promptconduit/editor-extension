// First-run setup guidance. The extension only reads what the promptconduit CLI
// records in ~/.promptconduit, so a fresh install with no CLI shows "—" forever
// unless we say what to do. Pure (no vscode, no fs) so the webview bundle can
// import the constants and the decision is unit-testable.

import { marketingUrl } from "./marketingUrl";

/** Where to send people when there's no one-click installer (Windows, the Marketplace package). */
export const INSTALL_DOCS_PATH = "/docs/installation";
/** Hooks the CLI into Claude Code / Cursor. The installer runs it when interactive. */
export const INIT_COMMAND = "promptconduit init";

export type SetupStep = "install-cli" | "run-init" | "ready";

export interface SetupProbe {
  /** The CLI binary was found (configured path, PATH, or a known install dir). */
  cliFound: boolean;
  /** events.jsonl (or its rotation) exists: the CLI has recorded something. */
  eventLogExists: boolean;
  /** PROMPTCONDUIT_EVENT_LOG=0: the user turned the local log off on purpose. */
  logDisabled: boolean;
}

/**
 * What the user still has to do before cost can appear. An existing event log
 * always means "ready": data is flowing, so the CLI is evidently installed even
 * if we couldn't find the binary (unusual PATH), and we must never nag then.
 */
export function setupStep(p: SetupProbe): SetupStep {
  if (p.eventLogExists) {
    return "ready";
  }
  if (!p.cliFound) {
    return "install-cli";
  }
  return p.logDisabled ? "ready" : "run-init";
}

/** Serializable setup card state for the Cost Breakdown webview. */
export interface SetupState {
  step: Exclude<SetupStep, "ready">;
  /** The curl installer, or undefined where it doesn't apply (Windows, the Marketplace package). */
  installCommand?: string;
  initCommand: string;
  docsUrl: string;
}

/**
 * @param installCommand the one-click installer (optionalFeatures.installCommand()),
 *   undefined in the VS Code Marketplace package, which links to the docs instead.
 */
export function setupState(step: SetupStep, platform: string, installCommand?: string): SetupState | undefined {
  if (step === "ready") {
    return undefined;
  }
  return {
    step,
    installCommand: platform === "win32" ? undefined : installCommand,
    initCommand: INIT_COMMAND,
    docsUrl: marketingUrl(INSTALL_DOCS_PATH, "cost_panel", "setup"),
  };
}

/** Status bar text/tooltip while setup is incomplete and nothing is tracked yet. */
export function setupStatusBar(step: SetupStep, installCommand?: string): { text: string; tooltip: string } | undefined {
  switch (step) {
    case "install-cli":
      return {
        text: "$(zap) Set up cost tracking",
        tooltip:
          "**PromptConduit needs its free CLI** to record AI session costs on this machine.\n\n" +
          (installCommand
            ? `Install it with \`${installCommand}\`, then run \`${INIT_COMMAND}\`.\n\n`
            : `Install it from promptconduit.dev${INSTALL_DOCS_PATH}, then run \`${INIT_COMMAND}\`.\n\n`) +
          "_Click for setup steps._",
      };
    case "run-init":
      return {
        text: "$(zap) Finish setup",
        tooltip:
          "**The PromptConduit CLI is installed** but hasn't recorded an AI session yet.\n\n" +
          `Run \`${INIT_COMMAND}\` to connect Claude Code or Cursor, then start a session.\n\n` +
          "_Click for setup steps._",
      };
    default:
      return undefined;
  }
}
