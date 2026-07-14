import { test, expect, _electron as electron, type Page } from "@playwright/test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// End-to-end test of Cursor agent-tab following (session-focus-follow): the
// CursorTabTracker polls the WORKSPACE storage SQLite DB
// (<userDataDir>/User/workspaceStorage/<hash>/state.vscdb, ItemTable key
// 'composer.composerData' → {"lastFocusedComposerIds":["<focused first>",…]})
// every 2s and switches the Stream panel to the focused composerId, which is
// the conversation_id our Cursor events are keyed by.
//
// Seeding mirrors stream-panel.spec.ts, EXCEPT the claude-code session gets
// the NEWEST timestamps — pure activity-following would therefore show the
// claude-code session, so the panel landing on tab-A / tab-B proves the tab
// signal (not recency) drives the switch. We write the composer row into the
// hash dir Cursor itself creates; the tracker treats a missing DB as "not
// yet", so the next 2s poll picks up whatever we write.

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

const CURSOR_BIN = process.env.CURSOR_BIN; // extracted Cursor Electron binary
const EXT_DEV_PATH = process.env.EXT_DEV_PATH ?? process.cwd(); // repo root (has out/)

const TAB_A = "tab-A";
const TAB_B = "tab-B";

// Seed ~/.promptconduit/events.jsonl in a temp HOME. Three sessions like
// stream-panel.spec.ts, but with claude-code NEWEST. All hooks are
// non-interaction ones (no UserPromptSubmit / beforeSubmitPrompt) so no
// "interaction" focus gesture competes with the cursor-tab signal — the only
// thing that can pull the panel off activity-following is the seeded DB row.
function writeSeededHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pc-home-"));
  const dir = path.join(home, ".promptconduit");
  fs.mkdirSync(dir, { recursive: true });
  const base = Date.now();
  const at = (offsetSec: number) => new Date(base + offsetSec * 1000).toISOString();
  let seq = 0;
  const events = [
    // cursor tab-A (oldest)
    { tool: "cursor", hook_event: "beforeShellExecution", session: "sess-A", raw: { conversation_id: TAB_A }, ts: at(0) },
    { tool: "cursor", hook_event: "afterShellExecution", session: "sess-A", raw: { conversation_id: TAB_A }, ts: at(5) },
    // cursor tab-B
    { tool: "cursor", hook_event: "beforeMcpExecution", session: "sess-B", raw: { conversation_id: TAB_B }, ts: at(10) },
    { tool: "cursor", hook_event: "afterAgentResponse", session: "sess-B", raw: { conversation_id: TAB_B }, ts: at(15) },
    // claude-code session cc-1 (NEWEST → activity-following would pick this)
    { tool: "claude-code", hook_event: "PreToolUse", session: "cc-1", raw: {}, ts: at(20) },
    { tool: "claude-code", hook_event: "PostToolUse", session: "cc-1", raw: {}, ts: at(25) },
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

// Locate the workspace-storage HASH dir Cursor created for the opened folder:
// <userDataDir>/User/workspaceStorage/<hash>/ — its workspace.json references
// the workspace path. Cursor creates it shortly after the window opens (we do
// NOT compute the hash ourselves); poll until it shows up. With a fresh
// user-data-dir there is usually exactly one, but filter by workspace.json to
// be safe.
async function findWorkspaceStorageDir(
  win: Page,
  userDataDir: string,
  workspace: string,
  timeoutMs: number,
): Promise<string> {
  const root = path.join(userDataDir, "User", "workspaceStorage");
  const wsMarker = path.basename(workspace); // mkdtemp basename is unique
  const deadline = Date.now() + timeoutMs;
  const seen: string[] = [];
  while (Date.now() < deadline) {
    seen.length = 0;
    if (fs.existsSync(root)) {
      for (const name of fs.readdirSync(root)) {
        const hashDir = path.join(root, name);
        if (!fs.statSync(hashDir).isDirectory()) {
          continue;
        }
        seen.push(name);
        const wsJson = path.join(hashDir, "workspace.json");
        if (fs.existsSync(wsJson)) {
          try {
            if (fs.readFileSync(wsJson, "utf8").includes(wsMarker)) {
              return hashDir;
            }
          } catch {
            // mid-write; retry next round
          }
        }
      }
      // No workspace.json matched — with a single hash dir it can only be ours.
      if (seen.length === 1) {
        return path.join(root, seen[0]);
      }
    }
    await win.waitForTimeout(1_000);
  }
  throw new Error(
    `No workspaceStorage hash dir for ${wsMarker} in ${root} within ${timeoutMs}ms (saw: [${seen.join(", ")}])`,
  );
}

// Write lastFocusedComposerIds into ItemTable via the sqlite3 CLI. Cursor may
// have already created state.vscdb (and hold it open) — so UPDATE/INSERT the
// row rather than replacing the file, with a busy timeout + retries in case
// Cursor is mid-write. If the DB doesn't exist yet, this creates it; the
// tracker treats a missing DB as "not yet" and picks it up on the next poll.
function seedFocusedComposer(dbPath: string, composerId: string): void {
  const value = JSON.stringify({ lastFocusedComposerIds: [composerId] });
  const sql = [
    "PRAGMA busy_timeout=5000;",
    "CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
    `INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('composer.composerData', '${value}');`,
  ].join(" ");
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      execFileSync("sqlite3", [dbPath, sql], { timeout: 10_000 });
      return;
    } catch (e) {
      lastErr = e; // likely SQLITE_BUSY from Cursor's own writer; retry
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000); // sync sleep 1s
    }
  }
  throw new Error(`sqlite3 seed of ${dbPath} failed after retries: ${lastErr}`);
}

test("Stream panel follows the focused Cursor agent tab (composerData), not activity", async () => {
  test.skip(!CURSOR_BIN, "CURSOR_BIN not set — run via the e2e-cursor workflow");
  // Boot + storage discovery + two 2s-poll flips need more than the default.
  test.setTimeout(300_000);

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
  await win.screenshot({ path: "out/screenshots/cursor-tab-01-loaded.png" });

  // Focus tab-A via Cursor's own workspace state DB. The tracker resolved the
  // DB path at activation (dirname of the extension's storageUri) and treats a
  // missing file as "not yet", so writing now is race-free: the next 2s poll
  // sees it.
  const hashDir = await findWorkspaceStorageDir(win, userDataDir, workspace, 60_000);
  const dbPath = path.join(hashDir, "state.vscdb");
  seedFocusedComposer(dbPath, TAB_A);

  // Open the Stream editor tab via the command palette.
  await win.keyboard.press(process.platform === "darwin" ? "Meta+Shift+P" : "F1");
  await win.locator(".quick-input-widget").waitFor({ timeout: 15_000 });
  await win.keyboard.type("PromptConduit: Show Stream Panel");
  await win.waitForTimeout(500);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(3_000);
  await win.screenshot({ path: "out/screenshots/cursor-tab-02-panel-opened.png" });

  // The panel must land on tab-A because of the tab signal — the claude-code
  // session has the newest events, so activity-following alone would never
  // show a Cursor conversation. Grab the frame by the cursor-tab follow note
  // (unique to the agent-tab-following state); generous timeout covers the
  // 2s poll cadence on a slow CI xvfb.
  //
  // NOTE: expect() retries do NOT survive the nested webview contentFrame()
  // chain here (an expect that misses on its first poll aborts with
  // "element(s) not found" instead of retrying) — so every state transition is
  // gated on the content-scanning webviewWithText loop, and the expects below
  // each gate only assert content that renders atomically with the gate text.
  const webview = await webviewWithText(win, "Following the selected Cursor agent tab.", 45_000);
  const hookBadge = (hook: string) => webview.locator("details.evt .hook", { hasText: hook });
  await expect(webview.locator(".pill", { hasText: "agent tab" })).toBeVisible();
  await expect(webview.getByText("conversation_id (Cursor tab)")).toBeVisible();
  await expect(webview.locator("code.skey", { hasText: TAB_A })).toBeVisible();
  await expect(hookBadge("beforeShellExecution")).toBeVisible();
  await expect(hookBadge("afterShellExecution")).toBeVisible();
  // Other sessions' events must be absent — especially the newest (claude-code).
  await expect(hookBadge("PreToolUse")).toHaveCount(0);
  await expect(hookBadge("PostToolUse")).toHaveCount(0);
  await expect(hookBadge("afterAgentResponse")).toHaveCount(0);
  await win.screenshot({ path: "out/screenshots/cursor-tab-03-following-tab-a.png" });

  // Switch the focused tab to tab-B in the DB; the panel must flip within a
  // couple of 2s poll cycles. Gate on "tab-B" appearing — the string exists
  // nowhere in the tab-A view (different session, different events) — then
  // assert the atomically-rendered tab-B state. Re-scan for the frame instead
  // of reusing the handle: see the retry note above.
  seedFocusedComposer(dbPath, TAB_B);
  const flipped = await webviewWithText(win, TAB_B, 45_000);
  const hookBadgeB = (hook: string) => flipped.locator("details.evt .hook", { hasText: hook });
  await expect(flipped.locator("code.skey", { hasText: TAB_B })).toBeVisible();
  await expect(flipped.locator(".pill", { hasText: "agent tab" })).toBeVisible();
  await expect(flipped.getByText("Following the selected Cursor agent tab.")).toBeVisible();
  await expect(hookBadgeB("afterAgentResponse")).toBeVisible();
  await expect(hookBadgeB("beforeMcpExecution")).toBeVisible();
  await expect(hookBadgeB("beforeShellExecution")).toHaveCount(0);
  await expect(hookBadgeB("PreToolUse")).toHaveCount(0);
  await win.screenshot({ path: "out/screenshots/cursor-tab-04-flipped-tab-b.png" });

  await flipped.locator("body").screenshot({ path: "out/screenshots/cursor-tab-05-webview-frame.png" });
  await app.close();
});
