import { defineConfig } from "@playwright/test";

// E2E config for the Cursor (Electron) UI tests. These drive the *real* Cursor
// editor under xvfb in CI and screenshot the rendered Telemetry panel — they do
// NOT run in a browser. See test/e2e/README.md.
export default defineConfig({
  testDir: "./test/e2e",
  // Booting Cursor + activating the extension is slow; be generous.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1, // one editor instance at a time
  reporter: [["list"], ["html", { open: "never", outputFolder: "out/playwright-report" }]],
  outputDir: "out/test-results",
});
