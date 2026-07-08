import { defineConfig } from "@playwright/test";

// LOCAL macOS screenshot capture — drives your signed-in Cursor.app HEADED (real
// window, real GPU), no xvfb. Separate from playwright.config.ts (the CI/Linux
// e2e suite). Run via `npm run capture`.
export default defineConfig({
  testDir: "./test/capture",
  testMatch: "**/*.capture.ts",
  timeout: 150_000, // booting Cursor + opening a panel is slow
  fullyParallel: false,
  workers: 1, // one Cursor instance at a time
  retries: 0,
  reporter: [["list"]],
  outputDir: "out/capture/test-results",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
