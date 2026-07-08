import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { seedDataDir, type PanelScenario } from "../../dev/seedDataDir";
import {
  resolveCursorBin,
  captureProfileReady,
  captureProfileDir,
  launchCursor,
  openPanel,
  webviewWithText,
  screenshotEditor,
  OUT_DIR,
} from "./harness";

// Capture clean screenshots of each PromptConduit panel in the REAL, signed-in
// Cursor.app (macOS, headed). One Cursor launch per panel — each panel follows
// the most-recently-active session, so each gets its own seeded log. Writes a
// full-window shot (IDE chrome) and a panel-only shot (the webview body) to
// out/capture/. Run via `npm run capture` (see scripts/capture-screenshots.sh).

const CURSOR_BIN = resolveCursorBin();

interface PanelCapture {
  scenario: PanelScenario;
  command: string; // command-palette title (from package.json contributes.commands)
  signature: string; // stable text proving the panel rendered
  slug: string; // output filename stem
  webgl?: boolean;
}

const PANELS: PanelCapture[] = [
  { scenario: "cost", command: "PromptConduit: Show Cost Breakdown", signature: "Cost per prompt", slug: "cost-breakdown" },
  { scenario: "stream", command: "PromptConduit: Show Stream Panel", signature: "auto-following", slug: "stream" },
  { scenario: "coaching", command: "PromptConduit: Show Agent Coaching", signature: "Agent coaching", slug: "agent-coaching" },
  { scenario: "theater", command: "PromptConduit: Show Orchestration Theater", signature: "Orchestration Theater", slug: "orchestration-theater", webgl: true },
];

test.describe("PromptConduit panel screenshots (real Cursor, signed in)", () => {
  test.skip(!CURSOR_BIN, "Cursor.app not found — install Cursor to capture screenshots.");
  test.skip(
    !captureProfileReady(),
    `Capture profile not signed in yet. One-time: open -na Cursor --args --user-data-dir="${captureProfileDir()}" → sign in → quit. Or run scripts/capture-screenshots.sh, which guides you.`,
  );

  for (const p of PANELS) {
    test(`capture ${p.slug}`, async () => {
      const seededDir = seedDataDir(p.scenario);
      fs.mkdirSync(OUT_DIR, { recursive: true });

      const { app, win } = await launchCursor({ cursorBin: CURSOR_BIN!, seededDir, webgl: p.webgl });
      try {
        // Always capture the initial state so a failure to open the palette is diagnosable.
        await win.screenshot({ path: path.join(OUT_DIR, `${p.slug}-00-launched.png`) });
        await openPanel(win, p.command);

        // Locate the panel's webview by content. A timeout here almost always
        // means the profile isn't signed in (Cursor's login overlay occludes the
        // workbench) — surface that hint rather than a bare Playwright error.
        let webview;
        try {
          webview = await webviewWithText(win, p.signature, 30_000);
        } catch (err) {
          await win.screenshot({ path: path.join(OUT_DIR, `${p.slug}-FAILED.png`) });
          throw new Error(
            `${p.slug}: panel "${p.signature}" not found. If the screenshot shows a "Log In / Sign Up" gate, ` +
              `re-sign-in the capture profile: open -na Cursor --args --user-data-dir="${captureProfileDir()}". Cause: ${String(err)}`,
          );
        }

        await expect(webview.getByText(p.signature).first()).toBeVisible();
        await win.waitForTimeout(1_000); // settle animations/first render

        await screenshotEditor(win, path.join(OUT_DIR, `${p.slug}-window.png`)); // title bar cropped
        await webview.locator("body").screenshot({ path: path.join(OUT_DIR, `${p.slug}-panel.png`) });
      } finally {
        await app.close();
      }
    });
  }
});
