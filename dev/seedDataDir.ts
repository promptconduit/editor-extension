// Materialize a seeded PromptConduit data dir (an events.jsonl) for a given panel
// scenario, and return its path. Point PROMPTCONDUIT_DIR at it (see src/dataDir.ts)
// so every PromptConduit surface reads the seeded data WITHOUT overriding $HOME —
// which on macOS would move Cursor's auth profile and re-trigger the login wall.
//
// Reuses the same fixtures the webview preview and unit tests use (./fixtures), so
// the seeded panels stay in sync with what we already validate. Used by the local
// screenshot-capture harness (test/capture) — one seeded dir per panel, since each
// panel follows the most-recently-active session in the log.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  samplePromptStoryLines,
  sampleStreamLines,
  sampleTheaterLines,
  sampleCoachingLines,
} from "./fixtures";

export type PanelScenario = "cost" | "stream" | "theater" | "coaching";

export const PANEL_SCENARIOS: PanelScenario[] = ["cost", "stream", "theater", "coaching"];

const SCENARIO_LINES: Record<PanelScenario, string[]> = {
  cost: samplePromptStoryLines, // per-prompt cost ledger (plan mode, MCP, subagent, PR/worktree)
  stream: sampleStreamLines, // Cursor tab-B auto-followed, interleaved with Claude Code
  theater: sampleTheaterLines, // lead → 3 parallel subagents → tools
  coaching: sampleCoachingLines, // full coaching signals (interruptions, modes, skills)
};

/**
 * Write the seeded events.jsonl for `scenario` into a fresh temp dir and return
 * that dir. The dir IS the data dir (pass it verbatim as PROMPTCONDUIT_DIR).
 */
export function seedDataDir(scenario: PanelScenario): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pc-seed-${scenario}-`));
  fs.writeFileSync(path.join(dir, "events.jsonl"), SCENARIO_LINES[scenario].join("\n") + "\n");
  return dir;
}
