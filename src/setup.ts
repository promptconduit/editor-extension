// First-run setup guidance. The extension only reads what the promptconduit CLI
// records in ~/.promptconduit, so a fresh install with no CLI shows "—" forever
// unless we say what to do. Pure (no vscode, no fs) so the webview bundle can
// import the constants and the decision is unit-testable.

import { marketingUrl } from "./marketingUrl";

/** The one supported install path (no Homebrew: it was retired in CLI v0.13.2). */
export const INSTALL_COMMAND = "curl -fsSL https://promptconduit.dev/install | bash";
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
  /** The curl installer, or undefined where it doesn't apply (Windows). */
  installCommand?: string;
  initCommand: string;
  docsUrl: string;
}

export function setupState(step: SetupStep, platform: string): SetupState | undefined {
  if (step === "ready") {
    return undefined;
  }
  return {
    step,
    installCommand: platform === "win32" ? undefined : INSTALL_COMMAND,
    initCommand: INIT_COMMAND,
    docsUrl: marketingUrl("/docs/installation", "cost_panel", "setup"),
  };
}

/** Status bar text/tooltip while setup is incomplete and nothing is tracked yet. */
export function setupStatusBar(step: SetupStep): { text: string; tooltip: string } | undefined {
  switch (step) {
    case "install-cli":
      return {
        text: "$(zap) Set up cost tracking",
        tooltip:
          "**PromptConduit needs its free CLI** to record AI session costs on this machine.\n\n" +
          `Install it with \`${INSTALL_COMMAND}\`, then run \`${INIT_COMMAND}\`.\n\n` +
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
