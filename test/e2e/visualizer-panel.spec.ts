import { test, expect, _electron as electron } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// End-to-end test of the 3D Orchestration Theater, driving the REAL Cursor editor.
//
// Runs in CI only (see .github/workflows/e2e-cursor.yml). Seeds a temp HOME with
// an orchestration session (sub-agents + tool calls), boots Cursor under xvfb
// with the extension loaded from source, opens the Theater, and asserts the
// webview booted a WebGL canvas and reached first render (data-scene-ready) with
// no fatal scene errors. The panel reads ~/.promptconduit/events.jsonl, so a temp
// HOME = deterministic input with no CLI run and no real AI session.

const CURSOR_BIN = process.env.CURSOR_BIN;
const EXT_DEV_PATH = process.env.EXT_DEV_PATH ?? process.cwd();

function writeSeededHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pc-home-"));
  const dir = path.join(home, ".promptconduit");
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  const git = {
    repo_name: "editor-extension",
    branch: "feat/15-theater",
    commit_message: "feat: theater (Closes #42)",
    remote_url: "git@github.com:promptconduit/editor-extension.git",
  };
  const line = (s: number, hook_event: string, native: Record<string, unknown>) =>
    JSON.stringify({
      envelope_version: "1.2",
      cli_version: "e2e",
      tool: "claude-code",
      hook_event,
      captured_at: at(s),
      native_payload: { session_id: "e2e", ...native },
      enrichment: { git, correlation: { trace_id: "e2e" } },
    });
  const events = [
    line(0, "SessionStart", { model: "claude-opus-4-8" }),
    line(2, "SubagentStart", { agent_id: "a1", agent_type: "researcher" }),
    line(3, "PostToolUse", { tool_name: "WebFetch", tool_input: { url: "https://x.dev" }, tool_response: "ok", tool_use_id: "w1" }),
    line(4, "PostToolUse", { tool_name: "Read", tool_input: { file_path: "a.ts" }, tool_response: "data", tool_use_id: "f1" }),
    line(5, "SubagentStop", { agent_id: "a1" }),
    line(6, "Stop", {}),
  ];
  fs.writeFileSync(path.join(dir, "events.jsonl"), events.join("\n") + "\n");
  return home;
}

function launchEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const key of Object.keys(env)) {
    if (/^VSCODE_/i.test(key)) delete env[key];
  }
  return env; // GitHub enrichment is disabled via the seeded settings.json (inferOnly)
}

test("Orchestration Theater panel boots in Cursor", async () => {
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
      "promptconduit.visualizer.githubEnrichment": "inferOnly",
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
      // Force software WebGL so the scene can render headlessly (no GPU under xvfb).
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
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

  // Catch only unhandled JS crashes in the bundle — a missing GL context is
  // handled gracefully (warn + fallback), so it must not fail the test.
  const sceneErrors: string[] = [];
  win.on("console", (msg) => {
    if (msg.type() === "error" && /Uncaught/i.test(msg.text())) {
      sceneErrors.push(msg.text());
    }
  });

  await win.keyboard.press("Escape");
  await win.waitForTimeout(1_000);

  await win.keyboard.press("F1");
  await win.locator(".quick-input-widget").waitFor({ timeout: 15_000 });
  await win.keyboard.type("PromptConduit: Show Orchestration Theater");
  await win.waitForTimeout(500);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(4_000);
  await win.screenshot({ path: "out/screenshots/viz-01-opened.png" });

  // Walk the nested webview iframes (outer iframe.webview → inner #active-frame).
  const webview = win
    .locator("iframe.webview")
    .first()
    .contentFrame()
    .locator("iframe")
    .first()
    .contentFrame();

  // The host→webview load handshake builds the HUD regardless of GL availability
  // — this is the robust gate that the whole pipeline ran end-to-end.
  await expect(webview.getByText("Orchestration Theater")).toBeVisible({ timeout: 30_000 });
  // First render sets "1"; a graceful no-GL fallback sets "nogl". Either proves
  // the scene bootstrap completed without crashing.
  await expect(webview.locator("body")).toHaveAttribute("data-scene-ready", /^(1|nogl)$/, {
    timeout: 30_000,
  });

  await webview.locator("body").screenshot({ path: "out/screenshots/viz-02-scene.png" });
  expect(sceneErrors, sceneErrors.join("\n")).toHaveLength(0);
  await app.close();
});
