import { defineConfig } from "vitest/config";

// Fast unit tests over the extension's pure logic (no editor, no vscode).
// E2E (Playwright/Cursor) lives under test/e2e and is run separately.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    // Files like eventsFeed.ts/statusBar.ts import `vscode` for their provider
    // classes but also export pure helpers we want to test — stub the import.
    alias: { vscode: new URL("./test/mocks/vscode.ts", import.meta.url).pathname },
  },
});
