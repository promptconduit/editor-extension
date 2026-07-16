import { test, expect, _electron as electron, type Page } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Find the webview whose inner frame contains `text` (same content-scan as
// stream-panel.spec.ts — DOM order is fragile with several webviews open).
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

// End-to-end test of the live Session Graph panel, driving the REAL Cursor
// editor (CI only, see e2e-cursor.yml): a temp HOME with a seeded v2
// events.jsonl gives deterministic input with no CLI run.
// Seeds one Claude Code session with a completed turn (tools + a costed
// subagent) and an OPEN second turn (running/pulsing), asserts the tree
// renders, then APPENDS the closing Stop to events.jsonl and asserts the live
// tail flips the open turn to completed — the panel updating in place is the
// whole feature.

const CURSOR_BIN = process.env.CURSOR_BIN; // extracted Cursor Electron binary
const EXT_DEV_PATH = process.env.EXT_DEV_PATH ?? process.cwd(); // repo root (has out/)

let seq = 0;
function line(hook: string, ts: string, extra: Record<string, unknown>, enrichments: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 2,
    event_id: `e2e-graph-${++seq}`,
    session_id: "cc-e2e",
    ...(extra.prompt_id ? { prompt_id: extra.prompt_id } : {}),
    cli_version: "e2e",
    tool: "claude-code",
    hook_event: hook,
    captured_at: ts,
    raw_event: { session_id: "cc-e2e", hook_event_name: hook, ...(extra.raw ?? {}) },
    enrichments: { vcs: { repo: "promptconduit/demo-repo", branch: "main" }, ...enrichments },
  });
}

function writeSeededHome(): { home: string; eventsPath: string; at: (s: number) => string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pc-home-"));
  const dir = path.join(home, ".promptconduit");
  fs.mkdirSync(dir, { recursive: true });
  const base = Date.now() - 120_000; // two minutes of history, safely "live"
  const at = (offsetSec: number) => new Date(base + offsetSec * 1000).toISOString();
  const events = [
    line("SessionStart", at(0), { raw: { model: "claude-opus-4-8" } }),
    // Turn 1: completed, with tools and a paired subagent carrying cost.
    line("UserPromptSubmit", at(5), { prompt_id: "p1", raw: { prompt: "explore the adapter architecture" } }),
    line("PostToolBatch", at(10), { prompt_id: "p1" }, {
      tools: { total: 3, failed: 0, calls: [{ name: "Read", ok: true }, { name: "Read", ok: true }, { name: "Grep", ok: true }] },
    }),
    line("SubagentStart", at(15), { prompt_id: "p1", raw: { agent_id: "e2e-a1", agent_type: "Explore" } }, {
      subagent: { agent_id: "e2e-a1", agent_type: "Explore", phase: "start", concurrent: 1 },
    }),
    line("SubagentStop", at(55), { prompt_id: "p1", raw: { agent_id: "e2e-a1" } }, {
      subagent: { agent_id: "e2e-a1", agent_type: "Explore", phase: "stop", duration_ms: 40000, usd: { total: 0.12, currency: "USD" } },
    }),
    line("Stop", at(60), { prompt_id: "p1" }, { turn: { duration_ms: 55000, prompt_id: "p1" } }),
    // Turn 2: OPEN — renders running (pulsing) until the appended Stop below.
    line("UserPromptSubmit", at(70), { prompt_id: "p2", raw: { prompt: "now wire it into the panel" } }),
  ];
  const eventsPath = path.join(dir, "events.jsonl");
  fs.writeFileSync(eventsPath, events.join("\n") + "\n");
  return { home, eventsPath, at };
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

test("Session Graph renders the live tree and updates in place from the tail", async () => {
  test.skip(!CURSOR_BIN, "CURSOR_BIN not set — run via the e2e-cursor workflow");

  const { home, eventsPath, at } = writeSeededHome();
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

  // Open the Session Graph tab via the command palette.
  await win.keyboard.press("F1");
  await win.locator(".quick-input-widget").waitFor({ timeout: 15_000 });
  await win.keyboard.type("PromptConduit: Show Session Graph");
  await win.waitForTimeout(500);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(3_000);
  await win.screenshot({ path: "out/screenshots/graph-01-panel-opened.png" });

  const webview = await webviewWithText(win, "promptconduit/demo-repo", 30_000);

  // Session root: repo @ branch, live.
  await expect(webview.locator('[data-node="session"]')).toBeVisible();
  await expect(webview.locator(".live-label.on", { hasText: "live" })).toBeVisible();

  // Turn 1 completed, with its tool chips and the costed subagent nested under it.
  const turn1 = webview.locator('[data-node="t:p1"]');
  await expect(turn1).toBeVisible();
  await expect(turn1).toHaveAttribute("data-state", "completed");
  await expect(turn1.locator(".chip", { hasText: "Read ×2" })).toBeVisible();
  const agent = webview.locator('[data-node="a:p1:e2e-a1"]');
  await expect(agent).toBeVisible();
  await expect(agent).toHaveAttribute("data-state", "completed");
  await expect(agent.getByText("$0.12")).toBeVisible();

  // Turn 2 is open → running (this is the pulsing box).
  const turn2 = webview.locator('[data-node="t:p2"]');
  await expect(turn2).toHaveAttribute("data-state", "running");

  // Elbow wires drew from the real DOM positions.
  expect(await webview.locator("svg.wires path").count()).toBeGreaterThan(0);
  await win.screenshot({ path: "out/screenshots/graph-02-live-tree.png" });

  // THE feature: append the closing Stop to events.jsonl and watch the open
  // turn flip to completed in place — no reopen, no refresh.
  fs.appendFileSync(
    eventsPath,
    line("Stop", at(125), { prompt_id: "p2" }, { turn: { duration_ms: 55000, prompt_id: "p2" } }) + "\n",
  );
  await expect(turn2).toHaveAttribute("data-state", "completed", { timeout: 10_000 });
  await win.screenshot({ path: "out/screenshots/graph-03-turn-closed-live.png" });

  await webview.locator("body").screenshot({ path: "out/screenshots/graph-04-webview-frame.png" });
  await app.close();
});
