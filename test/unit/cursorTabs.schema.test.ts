// Schema-drift canary for the Cursor workspace-storage contract.
//
// CursorTabTracker's whole feature rests on an undocumented contract with
// Cursor's workspace state database, as observed on Cursor 3.x (2026-07-13):
//
//   <workspaceStorage>/<hash>/state.vscdb  (plain SQLite)
//     TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)
//     key 'composer.composerData' → JSON with lastFocusedComposerIds,
//     whose FIRST element is the focused composer/agent tab id
//     (≡ the conversation_id reported by Cursor hooks).
//
// This suite builds a REAL SQLite database with exactly that shape via the
// sqlite3 CLI and runs the REAL runComposerQuery() against it. If it starts
// failing, either our query/parsing drifted or Cursor changed its schema —
// investigate before shipping. Skipped (not failed) when sqlite3 is absent.

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  runComposerQuery,
  parseComposerData,
  COMPOSER_DATA_KEY,
  COMPOSER_DATA_SQL,
} from "../../src/cursorTabs";

function sqlite3Available(): boolean {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
const hasSqlite3 = sqlite3Available();

const FOCUSED_ID = "8d760a23-c2ec-4f20-b07e-2bd41d93df0a";
const OTHER_ID = "9903f7df-cb89-4deb-88ff-957a814ef959";

// Verbatim shape of a live Cursor workspace composer.composerData value.
const COMPOSER_DATA_VALUE = JSON.stringify({
  hasMigratedComposerData: true,
  hasMigratedMultipleComposers: true,
  lastFocusedComposerIds: [FOCUSED_ID, OTHER_ID],
  selectedComposerIds: [OTHER_ID, FOCUSED_ID],
});

let tmpDir: string | undefined;

function makeStateDb(name: string): string {
  tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "cursor-tabs-schema-"));
  const dbPath = path.join(tmpDir, name);
  const sql = [
    "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);",
    `INSERT INTO ItemTable (key, value) VALUES ('${COMPOSER_DATA_KEY}', '${COMPOSER_DATA_VALUE}');`,
  ].join("\n");
  execFileSync("sqlite3", [dbPath, sql], { stdio: "pipe" });
  return dbPath;
}

afterAll(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe.skipIf(!hasSqlite3)("Cursor workspace-storage schema canary", () => {
  it("real query against a real Cursor-shaped state.vscdb yields the focused composerId", async () => {
    const dbPath = makeStateDb("state.vscdb");
    const raw = await runComposerQuery(dbPath);
    expect(parseComposerData(raw.trim())).toBe(FOCUSED_ID);
  });

  it("succeeds in read-only mode against a write-protected database file", async () => {
    const dbPath = makeStateDb("state-readonly.vscdb");
    fs.chmodSync(dbPath, 0o444);
    try {
      const raw = await runComposerQuery(dbPath);
      expect(parseComposerData(raw.trim())).toBe(FOCUSED_ID);
    } finally {
      fs.chmodSync(dbPath, 0o644); // so afterAll cleanup can delete it
    }
  });

  it("returns empty output (→ undefined) when the composer key is absent", async () => {
    tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "cursor-tabs-schema-"));
    const dbPath = path.join(tmpDir, "state-empty.vscdb");
    execFileSync(
      "sqlite3",
      [dbPath, "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);"],
      { stdio: "pipe" },
    );
    const raw = await runComposerQuery(dbPath);
    expect(raw.trim()).toBe("");
    expect(parseComposerData(raw.trim())).toBeUndefined();
  });

  it("rejects when the ItemTable schema is gone (self-disable path)", async () => {
    tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "cursor-tabs-schema-"));
    const dbPath = path.join(tmpDir, "state-no-table.vscdb");
    execFileSync("sqlite3", [dbPath, "CREATE TABLE Other (k TEXT);"], { stdio: "pipe" });
    await expect(runComposerQuery(dbPath)).rejects.toThrow();
  });

  it("pins the exact SQL we ship (documented contract)", () => {
    expect(COMPOSER_DATA_SQL).toBe(
      "SELECT value FROM ItemTable WHERE key='composer.composerData';",
    );
  });
});
