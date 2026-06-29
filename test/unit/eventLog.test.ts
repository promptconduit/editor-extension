import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readHistory } from "../../src/visualizer/eventLog";

let home: string;
let dir: string;

function line(hookEvent: string, sessionId: string): string {
  return JSON.stringify({
    tool: "claude-code",
    hook_event: hookEvent,
    captured_at: new Date().toISOString(),
    native_payload: { session_id: sessionId },
    enrichment: { correlation: { trace_id: "t" } },
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pc-evlog-"));
  dir = path.join(home, ".promptconduit");
  fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.PROMPTCONDUIT_EVENT_LOG;
});

describe("readHistory", () => {
  it("reads the rotated .1 (older) before the live file (chronological)", () => {
    fs.writeFileSync(path.join(dir, "events.jsonl.1"), line("SessionStart", "old") + "\n");
    fs.writeFileSync(path.join(dir, "events.jsonl"), line("Stop", "new") + "\n");
    const envs = readHistory(home);
    expect(envs.map((e) => e.hookEvent)).toEqual(["SessionStart", "Stop"]);
  });

  it("tolerates blank and malformed lines", () => {
    fs.writeFileSync(
      path.join(dir, "events.jsonl"),
      ["", "{not json", line("PreToolUse", "s"), "   ", "42"].join("\n") + "\n",
    );
    const envs = readHistory(home);
    expect(envs).toHaveLength(1);
    expect(envs[0].hookEvent).toBe("PreToolUse");
  });

  it("returns [] when there is no log at all", () => {
    expect(readHistory(home)).toEqual([]);
  });

  it("returns [] when the event log is disabled", () => {
    fs.writeFileSync(path.join(dir, "events.jsonl"), line("SessionStart", "s") + "\n");
    process.env.PROMPTCONDUIT_EVENT_LOG = "0";
    expect(readHistory(home)).toEqual([]);
  });
});
