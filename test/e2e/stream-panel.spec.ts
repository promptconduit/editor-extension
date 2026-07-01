import { test, expect, _electron as electron, type Page } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Find the panel webview whose inner frame contains `text`. Several PromptConduit
// views (Stream, Telemetry, Coaching) render webviews in the same panel, so
// selecting by DOM order (`.first()`) is fragile — it shifts when views are added
// or reordered. Scan by content instead so each spec targets its own view.
async function webviewWithText(win: Page, text: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    const outers = win.locator("iframe.webview");
    const count = await outers.count();
    for (let i = 0; i < count; i++) {
      try {
        const frame = outers.nth(i).contentFrame().locator("iframe").first().contentFrame();
        if ((await frame.getByText(text).count()) > 0) {
          return frame;
        }
      } catch (e) {
        lastErr = e; // frame not ready yet; keep scanning
      }
    }
    await win.waitForTimeout(500);
  }
  throw new Error(`No webview containing "${text}" found within ${timeoutMs}ms${lastErr ? ` (last: ${lastErr})` : ""}`);
}

// End-to-end test of the docked Stream panel, driving the REAL Cursor editor.
//
// Same harness as telemetry-panel.spec.ts (CI only, see e2e-cursor.yml): a temp
// HOME with a seeded events.jsonl gives deterministic input with no CLI run.
// The Stream panel groups events by session and follows the most-recently-active
// one, so we seed three sessions with increasing timestamps — the Cursor "tab-B"
// conversation is newest, so it must be the followed (auto-following) session,
// and the other sessions' events must NOT render.

const CURSOR_BIN = process.env.CURSOR_BIN; // extracted Cursor Electron binary
const EXT_DEV_PATH = process.env.EXT_DEV_PATH ?? process.cwd(); // repo root (has out/)

function writeSeededHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pc-home-"));
  const dir = path.join(home, ".promptconduit");
  fs.mkdirSync(dir, { recursive: true });
  const base = Date.now();
  const at = (offsetSec: number) => new Date(base + offsetSec * 1000).toISOString();
  const events = [
    // claude-code session cc-1 (oldest)
    { tool: "claude-code", hook_event: "UserPromptSubmit", np: { session_id: "cc-1" }, ts: at(0) },
    // cursor tab-A
    { tool: "cursor", hook_event: "beforeShellExecution", np: { conversation_id: "tab-A", session_id: "sess-A" }, ts: at(10) },
    // cursor tab-B (newest → followed)
    { tool: "cursor", hook_event: "beforeSubmitPrompt", np: { conversation_id: "tab-B", session_id: "sess-B" }, ts: at(20) },
    { tool: "cursor", hook_event: "afterAgentResponse", np: { conversation_id: "tab-B", session_id: "sess-B" }, ts: at(25) },
  ].map((e) =>
    JSON.stringify({
      envelope_version: "1.2",
      cli_version: "e2e",
      tool: e.tool,
      hook_event: e.hook_event,
      captured_at: e.ts,
      native_payload: e.np,
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

test("Stream panel follows the most-recently-active session in Cursor", async () => {
  test.skip(!CURSOR_BIN, "CURSOR_BIN not set — run via the e2e-cursor workflow");

  const home = writeSeededHome();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-ud-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-ext-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pc-ws-"));
  fs.mkdirSync("out/screenshots", { recursive: true });

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
  await win.keyboard.press("Escape");
  await win.waitForTimeout(1_000);
  await win.screenshot({ path: "out/screenshots/stream-01-cursor-loaded.png" });

  // Focus our docked view via the command palette.
  await win.keyboard.press("F1");
  await win.locator(".quick-input-widget").waitFor({ timeout: 15_000 });
  await win.keyboard.type("PromptConduit: Show Stream Panel");
  await win.waitForTimeout(500);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(3_000);
  await win.screenshot({ path: "out/screenshots/stream-02-panel-opened.png" });

  // Grab the Stream view's webview by content (not DOM order — the panel hosts
  // several PromptConduit webviews). The followed session is tab-B (newest).
  const webview = await webviewWithText(win, "auto-following", 30_000);
  await expect(webview.getByText("auto-following")).toBeVisible();
  await expect(webview.getByText("afterAgentResponse")).toBeVisible();
  await expect(webview.getByText("beforeSubmitPrompt")).toBeVisible();
  // Other sessions' unique events must be absent while following tab-B.
  await expect(webview.getByText("UserPromptSubmit")).toHaveCount(0);
  await expect(webview.getByText("beforeShellExecution")).toHaveCount(0);

  await win.screenshot({ path: "out/screenshots/stream-03-window.png" });
  await webview.locator("body").screenshot({ path: "out/screenshots/stream-04-webview-frame.png" });
  await app.close();
});
