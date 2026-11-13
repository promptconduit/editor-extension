// Materialize a seeded PromptConduit data dir (an events.jsonl) for a panel
// scenario, and return its path. Point PROMPTCONDUIT_DIR at it (see src/dataDir.ts)
// so every PromptConduit surface reads the seeded data WITHOUT overriding $HOME —
// which on macOS would move Cursor's auth profile and re-trigger the login wall.
//
// Reuses the fixture the unit tests and the webview preview use, so the
// captured panel matches what we already validate. Used by the local
// screenshot-capture harness (test/capture).
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { lines as blogLines } from "../test/fixtures/blogPrompt";

export type PanelScenario = "loop";

export const PANEL_SCENARIOS: PanelScenario[] = ["loop"];

const SCENARIO_LINES: Record<PanelScenario, () => string[]> = {
  // A real "publish the blog post" prompt; no priced follow-up, so The Loop
  // opens on the blog prompt while following the latest one.
  loop: () => blogLines({ followUpCall: false }),
};

/**
 * Write the seeded events.jsonl for `scenario` into a fresh temp dir and return
 * that dir. The dir IS the data dir (pass it verbatim as PROMPTCONDUIT_DIR).
 */
export function seedDataDir(scenario: PanelScenario): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pc-seed-${scenario}-`));
  fs.writeFileSync(path.join(dir, "events.jsonl"), SCENARIO_LINES[scenario]().join("\n") + "\n");
  return dir;
}
