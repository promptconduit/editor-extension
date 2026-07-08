// Shared launch harness for the LOCAL macOS screenshot capture (test/capture).
//
// Unlike the CI e2e suite (test/e2e, Linux AppImage under xvfb, unauthenticated →
// login wall), this drives your locally-installed, SIGNED-IN Cursor.app so the
// panels render without a login overlay. Two decoupled knobs make that work:
//   • auth        → a persistent, pre-authenticated --user-data-dir (sign in once)
//   • panel data  → PROMPTCONDUIT_DIR points every surface at a seeded fixture dir
//                   (see src/dataDir.ts) WITHOUT touching $HOME, so auth is intact.
import { _electron as electron, type ElectronApplication, type FrameLocator, type Page } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** The real Cursor Electron binary (not the `cursor` CLI shim). CURSOR_BIN wins. */
export function resolveCursorBin(): string | undefined {
  const explicit = process.env.CURSOR_BIN;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const mac = "/Applications/Cursor.app/Contents/MacOS/Cursor";
  return fs.existsSync(mac) ? mac : undefined;
}

/** Persistent, pre-authenticated capture profile. Sign in ONCE (see the script). */
export function captureProfileDir(): string {
  return process.env.CURSOR_CAPTURE_PROFILE || path.join(os.homedir(), ".cursor-capture-profile");
}

/** True once the capture profile has been created (i.e. Cursor was launched with it). */
export function captureProfileReady(): boolean {
  return fs.existsSync(path.join(captureProfileDir(), "User"));
}

/** The extension source Cursor loads via --extensionDevelopmentPath (repo root). */
export const EXT_DEV_PATH = process.env.EXT_DEV_PATH ?? process.cwd();

/** Where captured PNGs are written. */
export const OUT_DIR = process.env.CAPTURE_OUT ?? "out/capture";

// Clean, consistent look for marketing shots. Auth lives in the profile's
// globalStorage (state.vscdb), NOT settings.json, so rewriting this each run is safe.
const CLEAN_SETTINGS: Record<string, unknown> = {
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "workbench.colorTheme": "Default Dark Modern",
  "update.mode": "none",
  "telemetry.telemetryLevel": "off",
  "editor.minimap.enabled": false,
  // The visualizer must not reach out to GitHub during capture.
  "promptconduit.visualizer.githubEnrichment": "inferOnly",
};

// Cursor/VS Code webviews fail to load (ServiceWorker "invalid state") if the
// child inherits the parent's VSCODE_* env. Strip them, and redirect every
// PromptConduit surface at the seeded data dir.
function captureEnv(seededDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PROMPTCONDUIT_DIR: seededDir };
  for (const k of Object.keys(env)) if (/^VSCODE_/i.test(k)) delete env[k];
  return env;
}

export interface LaunchOpts {
  cursorBin: string;
  seededDir: string;
  /** Visualizer needs a GL context; harmless elsewhere. */
  webgl?: boolean;
}

// Cursor 3.9+ opens an agent-first "Cursor Agents" home window; the classic VS
// Code workbench (where the command palette and our panels live, and where the
// extension is loaded via --extensionDevelopmentPath) is the separate
// "[Extension Development Host]" window, reached via the home's "Editor Window"
// affordance. Find that window (it's where keystrokes and panels work).
async function findEditorWindow(app: ElectronApplication): Promise<Page | undefined> {
  for (const w of app.windows()) {
    try {
      if ((await w.title()).includes("Extension Development Host")) return w;
    } catch {
      /* window mid-teardown */
    }
  }
  return undefined;
}

/** Launch signed-in Cursor with the extension from source and seeded data. */
export async function launchCursor(opts: LaunchOpts): Promise<{ app: ElectronApplication; win: Page }> {
  const profile = captureProfileDir();
  const userDir = path.join(profile, "User");
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, "settings.json"), JSON.stringify(CLEAN_SETTINGS, null, 2));

  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-cap-ext-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pc-cap-ws-"));

  const app = await electron.launch({
    executablePath: opts.cursorBin,
    args: [
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-updates",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-workspace-trust",
      ...(opts.webgl ? ["--ignore-gpu-blocklist"] : []),
      `--extensionDevelopmentPath=${EXT_DEV_PATH}`,
      `--extensions-dir=${extensionsDir}`,
      `--user-data-dir=${profile}`,
      workspace,
    ],
    env: captureEnv(opts.seededDir),
    timeout: 90_000,
  });

  const home = await app.firstWindow();
  await home.waitForLoadState("domcontentloaded");
  await home.waitForTimeout(6_000);
  await home.bringToFront();

  // Get the editor workbench window — either already open, or opened via the
  // "Editor Window" affordance on the agent home.
  let win = await findEditorWindow(app);
  if (!win) {
    await home.getByText("Editor Window").first().click({ timeout: 10_000 }).catch(() => {});
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && !win) {
      await home.waitForTimeout(500);
      win = await findEditorWindow(app);
    }
  }
  if (!win) throw new Error("Could not reach the editor workbench window (no '[Extension Development Host]' window).");

  await win.bringToFront();
  await win.locator(".monaco-workbench").waitFor({ state: "visible", timeout: 40_000 });
  await win.waitForTimeout(4_000); // onStartupFinished activation
  // Dismiss Cursor's first-run plugin/get-started onboarding for clean shots.
  await win.getByText("Skip", { exact: true }).first().click({ timeout: 2_000 }).catch(() => {});
  await win.keyboard.press("Escape");
  await win.waitForTimeout(500);
  return { app, win };
}

// Full-window screenshot with Cursor's title bar cropped off. Running via
// --extensionDevelopmentPath prefixes the title with "[Extension Development
// Host]", a dev tell we don't want in marketing shots; the title bar is a DOM
// part (.part.titlebar), so clip the frame to start just below it. Falls back to
// the full frame if the title bar can't be measured.
export async function screenshotEditor(win: Page, filePath: string): Promise<void> {
  const vp = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  let top = 0;
  try {
    const tb = await win.locator(".part.titlebar").first().boundingBox();
    if (tb && tb.height > 0 && tb.height < vp.height / 3) top = Math.ceil(tb.y + tb.height);
  } catch {
    /* keep the full frame */
  }
  await win.screenshot({ path: filePath, clip: { x: 0, y: top, width: vp.width, height: vp.height - top } });
}

// Open a panel via the command palette. On macOS, F1 is a hardware key the app
// never receives, so use Cmd+Shift+P; and keystrokes only route to a focused,
// front window — click the workbench and bring it to front first.
export async function openPanel(win: Page, commandTitle: string): Promise<void> {
  await win.bringToFront();
  await win.locator(".monaco-workbench").click({ position: { x: 8, y: 8 } }).catch(() => {});
  await win.keyboard.press("Meta+Shift+P");
  try {
    await win.locator(".quick-input-widget").waitFor({ state: "visible", timeout: 8_000 });
  } catch {
    // Retry once (first chord can be swallowed while the window takes focus).
    await win.keyboard.press("Meta+Shift+P");
    await win.locator(".quick-input-widget").waitFor({ state: "visible", timeout: 8_000 });
  }
  await win.keyboard.type(commandTitle);
  await win.waitForTimeout(600);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(3_000);
}

// Find the webview whose inner frame contains `text`. Multiple PromptConduit
// surfaces render webviews, so select by content (not DOM order). Mirrors the
// nested-iframe walk in test/e2e (outer iframe.webview → inner #active-frame).
export async function webviewWithText(win: Page, text: string, timeoutMs = 30_000): Promise<FrameLocator> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    const outers = win.locator("iframe.webview");
    const count = await outers.count();
    for (let i = 0; i < count; i++) {
      try {
        const frame = outers.nth(i).contentFrame().locator("iframe").first().contentFrame();
        if ((await frame.getByText(text).count()) > 0) return frame;
      } catch (e) {
        lastErr = e; // frame not ready yet; keep scanning
      }
    }
    await win.waitForTimeout(500);
  }
  throw new Error(`No webview containing "${text}" within ${timeoutMs}ms${lastErr ? ` (last: ${lastErr})` : ""}`);
}
