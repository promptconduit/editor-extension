// The one-click CLI installer command. Ships only in the Open VSX (Cursor)
// package; the VS Code Marketplace package omits this module
// (.vscodeignore.marketplace), and callers fall back to the install docs.
// Load it through optionalFeatures.installCommand(), never a static import.

/** The one supported install path (no Homebrew: it was retired in CLI v0.13.2). */
export const INSTALL_COMMAND = "curl -fsSL https://promptconduit.dev/install | bash";
