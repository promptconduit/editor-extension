// Features that ship only in the Open VSX (Cursor) package. The VS Code
// Marketplace package is built with .vscodeignore.marketplace, which leaves
// these modules out (the Marketplace's malware scan rejects a pipe-to-shell
// installer and reading Cursor's state.vscdb). Each loader returns undefined
// when its module isn't in the package, and callers degrade gracefully.

/** The curl installer, or undefined in the Marketplace package. */
export function installCommand(): string | undefined {
  try {
    return (require("./installer") as typeof import("./installer")).INSTALL_COMMAND;
  } catch {
    return undefined;
  }
}

/** Cursor agent-tab tracking, or undefined in the Marketplace package. */
export function cursorTabs(): typeof import("./cursorTabs") | undefined {
  try {
    return require("./cursorTabs") as typeof import("./cursorTabs");
  } catch {
    return undefined;
  }
}
