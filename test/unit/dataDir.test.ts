import { describe, it, expect, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import { dataDir, DATA_DIR_NAME } from "../../src/dataDir";
import { eventsJsonlPath as tailEventsPath } from "../../src/tail";
import { eventsDir, eventsJsonlPath } from "../../src/visualizer/paths";
import { markerPath } from "../../src/updatePrompt";

afterEach(() => {
  delete process.env.PROMPTCONDUIT_DIR;
});

describe("dataDir", () => {
  it("defaults to ~/.promptconduit when PROMPTCONDUIT_DIR is unset", () => {
    delete process.env.PROMPTCONDUIT_DIR;
    expect(dataDir()).toBe(path.join(os.homedir(), DATA_DIR_NAME));
  });

  it("honors PROMPTCONDUIT_DIR when set", () => {
    process.env.PROMPTCONDUIT_DIR = "/tmp/seeded-pc";
    expect(dataDir()).toBe("/tmp/seeded-pc");
  });

  it("ignores a blank PROMPTCONDUIT_DIR (falls back to the default)", () => {
    process.env.PROMPTCONDUIT_DIR = "   ";
    expect(dataDir()).toBe(path.join(os.homedir(), DATA_DIR_NAME));
  });

  it("redirects every panel's no-arg path resolver through the override", () => {
    process.env.PROMPTCONDUIT_DIR = "/tmp/seeded-pc";
    // Cost + Coaching (tail.ts), Stream + Orchestration Theater (visualizer/paths.ts),
    // and the update marker all resolve to the seeded dir.
    expect(tailEventsPath()).toBe("/tmp/seeded-pc/events.jsonl");
    expect(eventsJsonlPath()).toBe("/tmp/seeded-pc/events.jsonl");
    expect(eventsDir()).toBe("/tmp/seeded-pc");
    expect(markerPath()).toBe("/tmp/seeded-pc/extension-update.json");
  });

  it("still derives <home>/.promptconduit when an explicit home is passed (test injection)", () => {
    process.env.PROMPTCONDUIT_DIR = "/tmp/seeded-pc"; // must NOT win over an explicit arg
    expect(eventsDir("/fake/home")).toBe(path.join("/fake/home", DATA_DIR_NAME));
    expect(eventsJsonlPath("/fake/home")).toBe(path.join("/fake/home", DATA_DIR_NAME, "events.jsonl"));
  });
});
