import { test, expect, _electron as electron, type Page } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Find the webview whose inner frame contains `text`. Multiple PromptConduit
// surfaces render webviews in the workbench, so selecting by DOM order
// (`.first()`) is fragile. Scan by content instead so each spec targets its own.
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

// End-to-end test of the Stream editor-tab panel (a scripted webview since
// v0.16.0), driving the REAL Cursor editor (CI only, see e2e-cursor.yml): a
// temp HOME with a seeded v2 events.jsonl gives deterministic input with no
// CLI run.
// The Stream panel groups events by session and follows the most-recently-active
// one, so we seed three sessions with increasing timestamps — the Cursor "tab-B"
// conversation is newest, so it must be the followed (auto-following) session,
// and the other sessions' events must NOT render. Rows expand into the event's
// raw envelope JSON, and the header shows the full copyable conversation id.

const CURSOR_BIN = process.env.CURSOR_BIN; // extracted Cursor Electron binary
const EXT_DEV_PATH = process.env.EXT_DEV_PATH ?? process.cwd(); // repo root (has out/)

function writeSeededHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pc-home-"));
  const dir = path.join(home, ".promptconduit");
  fs.mkdirSync(dir, { recursive: true });
  const base = Date.now();
  const at = (offsetSec: number) => new Date(base + offsetSec * 1000).toISOString();
  let seq = 0;
  const events = [
    // claude-code session cc-1 (oldest)
    { tool: "claude-code", hook_event: "UserPromptSubmit", session: "cc-1", raw: {}, ts: at(0) },
    // cursor tab-A
    { tool: "cursor", hook_event: "beforeShellExecution", session: "sess-A", raw: { conversation_id: "tab-A" }, ts: at(10) },
    // cursor tab-B (newest → followed)
    { tool: "cursor", hook_event: "beforeSubmitPrompt", session: "sess-B", raw: { conversation_id: "tab-B" }, ts: at(20) },
    { tool: "cursor", hook_event: "afterAgentResponse", session: "sess-B", raw: { conversation_id: "tab-B" }, ts: at(25) },
  ].map((e) =>
    JSON.stringify({
      schema: 2,
      event_id: `e2e-evt-${++seq}`,
      session_id: e.session,
      cli_version: "e2e",
      tool: e.tool,
      hook_event: e.hook_event,
      captured_at: e.ts,
      raw_event: { session_id: e.session, hook_event_name: e.hook_event, ...e.raw },
      enrichments: { vcs: { repo: "promptconduit/demo-repo", branch: "main" } },
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

  // Open the Stream editor tab via the command palette.
  await win.keyboard.press("F1");
  await win.locator(".quick-input-widget").waitFor({ timeout: 15_000 });
  await win.keyboard.type("PromptConduit: Show Stream Panel");
  await win.waitForTimeout(500);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(3_000);
  await win.screenshot({ path: "out/screenshots/stream-02-panel-opened.png" });

  // Grab the Stream webview by content (not DOM order; nested iframe walk like
  // cost-panel.spec.ts). The followed session is tab-B (newest).
  const webview = await webviewWithText(win, "auto-following", 30_000);
  // Scope hook-name assertions to the row badge — the same strings also appear
  // inside each row's (hidden) raw-JSON tape.
  const hookBadge = (hook: string) => webview.locator("details.evt .hook", { hasText: hook });
  await expect(webview.getByText("auto-following")).toBeVisible();
  await expect(hookBadge("afterAgentResponse")).toBeVisible();
  await expect(hookBadge("beforeSubmitPrompt")).toBeVisible();
  // Other sessions' unique events must be absent while following tab-B.
  await expect(hookBadge("UserPromptSubmit")).toHaveCount(0);
  await expect(hookBadge("beforeShellExecution")).toHaveCount(0);

  // The explicit session identity: full conversation id + its copy button.
  await expect(webview.getByText("conversation_id (Cursor tab)")).toBeVisible();
  await expect(webview.locator("code.skey", { hasText: "tab-B" })).toBeVisible();
  await expect(webview.getByRole("button", { name: "Copy id" })).toBeVisible();

  await win.screenshot({ path: "out/screenshots/stream-03-window.png" });

  // Expand a row (click its summary) → the raw envelope JSON tape appears.
  await hookBadge("afterAgentResponse").click();
  await win.waitForTimeout(500);
  await expect(webview.getByText('"hook_event_name"', { exact: false }).first()).toBeVisible();
  await expect(webview.getByRole("button", { name: "Copy JSON" }).first()).toBeVisible();
  await win.screenshot({ path: "out/screenshots/stream-04-row-expanded.png" });

  await webview.locator("body").screenshot({ path: "out/screenshots/stream-05-webview-frame.png" });
  await app.close();
});
