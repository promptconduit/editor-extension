import { test, expect, _electron as electron } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// End-to-end test of the docked Telemetry panel, driving the REAL Cursor editor.
//
// Runs in CI only (see .github/workflows/e2e-cursor.yml): CI extracts the Cursor
// AppImage and points CURSOR_BIN at its Electron binary and EXT_DEV_PATH at this
// repo (compiled). This test seeds a temp HOME with a known events.jsonl, boots
// Cursor under xvfb with our extension loaded from source, focuses the Telemetry
// panel, asserts the seeded rows in the webview, and screenshots it.
//
// The panel reads ~/.promptconduit/events.jsonl, so a temp HOME = deterministic
// input with no CLI run and no real AI session.

const CURSOR_BIN = process.env.CURSOR_BIN; // extracted Cursor Electron binary
const EXT_DEV_PATH = process.env.EXT_DEV_PATH ?? process.cwd(); // repo root (has out/)

function writeSeededHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pc-home-"));
  const dir = path.join(home, ".promptconduit");
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const events = [
    { tool: "claude-code", hook_event: "UserPromptSubmit" },
    { tool: "claude-code", hook_event: "PreToolUse" },
    { tool: "cursor", hook_event: "Stop" },
  ].map((e) =>
    JSON.stringify({
      envelope_version: "1.2",
      cli_version: "e2e",
      tool: e.tool,
      hook_event: e.hook_event,
      captured_at: now,
      native_payload: {},
      enrichment: { git: { repo_name: "demo-repo", branch: "main" } },
    }),
  );
  fs.writeFileSync(path.join(dir, "events.jsonl"), events.join("\n") + "\n");
  return home;
}

// VS Code/Cursor webviews fail to load (ServiceWorker "invalid state" error) if
// the child inherits the parent's VSCODE_* env. Strip them. (Mandatory.)
function launchEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const key of Object.keys(env)) {
    if (/^VSCODE_/i.test(key)) delete env[key];
  }
  return env;
}

test("Telemetry panel renders seeded events in Cursor", async () => {
  test.skip(!CURSOR_BIN, "CURSOR_BIN not set — run via the e2e-cursor workflow");

  const home = writeSeededHome();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-ud-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-ext-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pc-ws-"));
  fs.mkdirSync("out/screenshots", { recursive: true });

  // Suppress the welcome/get-started editor so the workbench (and our panel)
  // aren't hidden behind it in the window screenshot.
  const userDir = path.join(userDataDir, "User");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDir, "settings.json"),
    JSON.stringify({
      "workbench.startupEditor": "none",
      "workbench.tips.enabled": false,
      "update.mode": "none",
      "telemetry.telemetryLevel": "off",
    }),
  );

  // Flags + env from microsoft/vscode-test via ruifigueira/vscode-test-playwright.
  const app = await electron.launch({
    executablePath: CURSOR_BIN!,
    args: [
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-updates",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-workspace-trust",
      `--extensionDevelopmentPath=${EXT_DEV_PATH}`,
      `--extensions-dir=${extensionsDir}`,
      `--user-data-dir=${userDataDir}`,
      workspace,
    ],
    env: launchEnv(home),
    timeout: 90_000,
  });

  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await win.waitForTimeout(8_000); // workbench + onStartupFinished activation
  // Best-effort: dismiss any welcome/login tab covering the workbench.
  await win.keyboard.press("Escape");
  await win.waitForTimeout(1_000);
  await win.screenshot({ path: "out/screenshots/01-cursor-loaded.png" });

  // Focus our docked view via the command palette (F1 is steadier than Ctrl+Shift+P).
  await win.keyboard.press("F1");
  await win.locator(".quick-input-widget").waitFor({ timeout: 15_000 });
  await win.keyboard.type("PromptConduit: Show Telemetry Panel");
  await win.waitForTimeout(500);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(3_000);
  await win.screenshot({ path: "out/screenshots/02-panel-opened.png" });

  // Walk the two nested webview iframes (outer iframe.webview → inner #active-frame)
  // with the modern contentFrame() pattern.
  const webview = win
    .locator("iframe.webview")
    .first()
    .contentFrame()
    .locator("iframe")
    .first()
    .contentFrame();

  await expect(webview.getByText("AI telemetry")).toBeVisible({ timeout: 30_000 });
  // Two distinct seeded events (unique text → one match each).
  await expect(webview.getByText("UserPromptSubmit")).toBeVisible();
  await expect(webview.getByText("PreToolUse")).toBeVisible();
  // All three seeded rows share repo "demo-repo" → exactly one Repo cell each.
  await expect(webview.getByText("demo-repo")).toHaveCount(3);

  // Debug captures only (uploaded on failure). On a fresh CI profile these are
  // occluded by Cursor's login wall — see README; the assertions above are the
  // real gate, not these images.
  await win.screenshot({ path: "out/screenshots/03-window.png" });
  await webview.locator("body").screenshot({ path: "out/screenshots/04-webview-frame.png" });
  await app.close();
});
