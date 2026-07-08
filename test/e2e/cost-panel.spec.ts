import { test, expect, _electron as electron } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { samplePromptStoryJsonl } from "../../dev/fixtures";

// End-to-end test of the AI Cost Breakdown detail report, driving the REAL
// Cursor editor (CI only — see .github/workflows/e2e-cursor.yml). Seeds a temp
// HOME with the per-prompt story fixture (plan-mode prompt, MCP tool calls, a
// priced subagent, an interrupt-free second prompt with a failing tool, cost on
// each Stop, and a vcs slug carrying a PR + worktree), opens the panel, expands
// everything, and asserts the ledger, mode badge, comparison, VCS line, and raw
// JSON all rendered inside the scripted webview.

const CURSOR_BIN = process.env.CURSOR_BIN;
const EXT_DEV_PATH = process.env.EXT_DEV_PATH ?? process.cwd();

function writeSeededHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pc-home-"));
  const dir = path.join(home, ".promptconduit");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "events.jsonl"), samplePromptStoryJsonl);
  return home;
}

function launchEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const key of Object.keys(env)) {
    if (/^VSCODE_/i.test(key)) delete env[key];
  }
  return env;
}

test("Cost Breakdown detail report renders the per-prompt ledger", async () => {
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

  const pageErrors: string[] = [];
  win.on("console", (msg) => {
    if (msg.type() === "error" && /Uncaught/i.test(msg.text())) {
      pageErrors.push(msg.text());
    }
  });

  await win.keyboard.press("Escape");
  await win.waitForTimeout(1_000);

  await win.keyboard.press("F1");
  await win.locator(".quick-input-widget").waitFor({ timeout: 15_000 });
  await win.keyboard.type("PromptConduit: Show Cost Breakdown");
  await win.waitForTimeout(500);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(4_000);
  await win.screenshot({ path: "out/screenshots/cost-01-opened.png" });

  // Walk the nested webview iframes (outer iframe.webview → inner #active-frame).
  const webview = win
    .locator("iframe.webview")
    .first()
    .contentFrame()
    .locator("iframe")
    .first()
    .contentFrame();

  // The ledger proves the whole pipeline ran: tail → envelope parse → prompt
  // grouping → view model → postMessage → client render.
  await expect(webview.getByText("Cost per prompt")).toBeVisible({ timeout: 30_000 });
  // The prompt text renders twice — as the entry excerpt and inside the raw-JSON
  // view — so scope to the first match (the excerpt) to avoid a strict-mode clash.
  await expect(
    webview.getByText("Review the cost breakdown code", { exact: false }).first(),
  ).toBeVisible();
  // The mode label is wrapped in a glossary tooltip, so its hidden <strong>
  // term shadows the visible chip text for getByText — target the chip by class.
  await expect(webview.locator(".chip-plan").first()).toBeVisible();
  await expect(webview.getByText("PR #65", { exact: false })).toBeVisible();
  await expect(webview.getByText("worktree").first()).toBeVisible();

  // Expand all → per-prompt comparison, tool calls, subagents, and raw JSON.
  // Cursor's unauthenticated "log in" overlay sits above the webview in CI and
  // intercepts real pointer events (the button itself is visible/enabled/stable),
  // so dispatch the click directly — the panel handles clicks via a delegated
  // document listener, so a synthetic bubbling click still triggers Expand all.
  await webview.getByRole("button", { name: "Expand all" }).dispatchEvent("click");
  await win.waitForTimeout(1_000);
  await expect(webview.getByText("What if", { exact: false }).first()).toBeVisible();
  await expect(webview.getByText("mcp__github__search_issues").first()).toBeVisible();
  await expect(webview.getByText("Subagents (1)", { exact: false })).toBeVisible();
  await expect(webview.getByText('"hook_event_name"', { exact: false }).first()).toBeVisible();
  await expect(webview.getByRole("button", { name: "Copy JSON" }).first()).toBeVisible();

  await win.screenshot({ path: "out/screenshots/cost-02-expanded.png" });
  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
  await app.close();
});
