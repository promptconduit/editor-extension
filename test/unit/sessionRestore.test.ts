import { describe, it, expect } from "vitest";
import {
  parseSessionsJson,
  isUnderAny,
  selectToRestore,
  sessionLabel,
  resumeCommand,
  pruneLedger,
  type RestorableSession,
} from "../../src/sessionRestore";

function sess(p: Partial<RestorableSession>): RestorableSession {
  return {
    session_id: "s1",
    tool: "claude-code",
    cwd: "/ws/repo",
    branch: "main",
    last_active: "2026-07-01T10:00:00Z",
    event_count: 3,
    alive: false,
    ...p,
  };
}

describe("parseSessionsJson", () => {
  it("parses a valid array and keeps only well-formed entries", () => {
    const raw = JSON.stringify([
      { session_id: "a", cwd: "/ws/a", tool: "claude-code", last_active: "", event_count: 1, alive: false },
      { session_id: "b" }, // missing cwd → dropped
      { cwd: "/ws/c" }, // missing session_id → dropped
    ]);
    const got = parseSessionsJson(raw);
    expect(got.map((s) => s.session_id)).toEqual(["a"]);
  });

  it("returns [] for invalid JSON, non-arrays, and empty", () => {
    expect(parseSessionsJson("not json")).toEqual([]);
    expect(parseSessionsJson("")).toEqual([]);
    expect(parseSessionsJson('{"session_id":"a"}')).toEqual([]);
    expect(parseSessionsJson("null")).toEqual([]);
  });
});

describe("isUnderAny", () => {
  it("matches the root itself and nested paths", () => {
    expect(isUnderAny("/ws/repo", ["/ws/repo"])).toBe(true);
    expect(isUnderAny("/ws/repo/sub/dir", ["/ws/repo"])).toBe(true);
    expect(isUnderAny("/ws/repo/.claude/worktrees/foo", ["/ws/repo"])).toBe(true);
  });

  it("rejects siblings, parents, and unrelated paths", () => {
    expect(isUnderAny("/ws/other", ["/ws/repo"])).toBe(false);
    expect(isUnderAny("/ws", ["/ws/repo"])).toBe(false);
    expect(isUnderAny("/elsewhere", ["/ws/repo"])).toBe(false);
    // A prefix that isn't a path boundary must not match.
    expect(isUnderAny("/ws/repo-2", ["/ws/repo"])).toBe(false);
  });

  it("matches any of several roots", () => {
    expect(isUnderAny("/b/x", ["/a", "/b"])).toBe(true);
  });
});

describe("selectToRestore", () => {
  const roots = ["/ws/repo"];
  const empty = new Set<string>();

  it("keeps interrupted, in-workspace, not-yet-restored sessions", () => {
    const got = selectToRestore([sess({ session_id: "keep", cwd: "/ws/repo/a" })], roots, empty, "auto");
    expect(got.map((s) => s.session_id)).toEqual(["keep"]);
  });

  it("drops sessions that are still running", () => {
    expect(selectToRestore([sess({ alive: true })], roots, empty, "auto")).toEqual([]);
  });

  it("drops sessions already in the restored ledger", () => {
    const got = selectToRestore([sess({ session_id: "done" })], roots, new Set(["done"]), "auto");
    expect(got).toEqual([]);
  });

  it("drops sessions outside the workspace", () => {
    expect(selectToRestore([sess({ cwd: "/other/place" })], roots, empty, "auto")).toEqual([]);
  });

  it("returns [] when mode is off or there is no workspace to scope to", () => {
    expect(selectToRestore([sess({})], roots, empty, "off")).toEqual([]);
    expect(selectToRestore([sess({})], [], empty, "auto")).toEqual([]);
  });

  it("restores worktree sessions (cwd points at the worktree path)", () => {
    const wt = sess({ session_id: "wt", cwd: "/ws/repo/.claude/worktrees/breezy", branch: "feat/x" });
    expect(selectToRestore([wt], roots, empty, "prompt").map((s) => s.session_id)).toEqual(["wt"]);
  });
});

describe("sessionLabel", () => {
  it("combines branch and last prompt", () => {
    expect(sessionLabel(sess({ branch: "feat/x", last_prompt: "do the thing" }))).toBe("feat/x — do the thing");
  });
  it("falls back to repo/dir when no branch", () => {
    expect(sessionLabel(sess({ branch: undefined, repo: "myrepo", last_prompt: undefined }))).toBe("myrepo");
  });
});

describe("resumeCommand", () => {
  it("is a plain --resume when the session has no add_dirs", () => {
    expect(resumeCommand(sess({ session_id: "abc-123" }))).toBe("claude --resume abc-123");
  });
  it("re-attaches each add_dir", () => {
    const s = sess({ session_id: "abc", add_dirs: ["/ws/cli", "/ws/editor-extension"] });
    expect(resumeCommand(s)).toBe(
      "claude --resume abc --add-dir /ws/cli --add-dir /ws/editor-extension",
    );
  });
  it("quotes dirs with spaces and skips malformed entries", () => {
    const s = sess({
      session_id: "abc",
      add_dirs: ["/ws/My Project", "", 7 as unknown as string],
    });
    expect(resumeCommand(s)).toBe('claude --resume abc --add-dir "/ws/My Project"');
  });
});

describe("pruneLedger", () => {
  it("drops entries older than the max age and keeps recent ones", () => {
    const now = 1_000_000_000_000;
    const day = 24 * 60 * 60 * 1000;
    const pruned = pruneLedger({ old: now - 8 * day, fresh: now - 1 * day }, now, 7 * day);
    expect(Object.keys(pruned)).toEqual(["fresh"]);
  });
});
