// Minimal `vscode` stub for unit tests. The pure render/helper functions under
// test never call the vscode API at module load or in their bodies; this only
// satisfies the `import * as vscode from "vscode"` in files that also export
// those pure helpers (eventsFeed.ts, statusBar.ts, panel.ts). esbuild erases the
// type-only references (`implements vscode.X`), so an empty module is enough.
export {};
