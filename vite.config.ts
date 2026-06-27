import { defineConfig } from "vite";

// Used by `vite-node` for the webview preview (npm run preview). Stubs the
// `vscode` import so the extension's pure HTML builders run outside the editor.
export default defineConfig({
  resolve: {
    alias: { vscode: new URL("./test/mocks/vscode.ts", import.meta.url).pathname },
  },
});
