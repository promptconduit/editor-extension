import { describe, it, expect } from "vitest";
import {
  SessionRestoreController,
  MAX_AUTO_RESTORE,
  type RestoreDeps,
  type RestorableSession,
  type RestoreMode,
} from "../../src/sessionRestore";

function sess(id: string, extra: Partial<RestorableSession> = {}): RestorableSession {
  return {
    session_id: id,
    tool: "claude-code",
    cwd: `/ws/repo/${id}`,
    branch: "main",
    last_active: "2026-07-01T10:00:00Z",
    event_count: 1,
    alive: false,
    ...extra,
  };
}

interface Harness {
  deps: RestoreDeps;
  opened: string[]; // session ids for which a terminal was created
  ledger: Record<string, number>; // the dismissed-sessions ledger (read-only here)
  infos: string[]; // messages shown
}

// `ledger` seeds the dismissed set (session_id → dismissed-at ms). The
// controller only reads it — dismissals are written elsewhere (on deliberate
// terminal close), so there is no writeLedger dep to stub.
function harness(opts: {
  sessions: RestorableSession[];
  mode?: RestoreMode;
  roots?: string[];
  ledger?: Record<string, number>;
  infoAnswer?: string; // what the info() prompt "returns"
  pick?: RestorableSession[]; // what the QuickPick returns
}): Harness {
  const opened: string[] = [];
  const ledger: Record<string, number> = { ...(opts.ledger ?? {}) };
  const infos: string[] = [];
  const deps: RestoreDeps = {
    resolveBinary: () => "/usr/local/bin/promptconduit",
    runSessions: async () => JSON.stringify(opts.sessions),
    createTerminal: (s) => opened.push(s.session_id),
    getRoots: () => opts.roots ?? ["/ws/repo"],
    getMode: () => opts.mode ?? "auto",
    getSinceHours: () => 12,
    readLedger: () => ledger,
    info: async (m) => {
      infos.push(m);
      return opts.infoAnswer;
    },
    pickSessions: async () => opts.pick ?? [],
    openSettings: () => {},
  };
  return { deps, opened, ledger, infos };
}

describe("SessionRestoreController.runStartup", () => {
  it("auto: silently reopens interrupted sessions without suppressing future restores", async () => {
    const h = harness({ sessions: [sess("a"), sess("b")], mode: "auto" });
    await new SessionRestoreController(h.deps).runStartup();
    expect(h.opened.sort()).toEqual(["a", "b"]);
    // Restoring must NOT write the dismissed ledger — otherwise a later reload
    // (same session_id via `claude --resume`) would be wrongly suppressed.
    expect(h.ledger).toEqual({});
    expect(h.infos.some((m) => /reopened 2/i.test(m))).toBe(true);
  });

  it("reopens the same interrupted sessions again on a subsequent refresh", async () => {
    // Simulates two window reloads: the sessions are interrupted both times and
    // were never dismissed, so both refreshes must reopen them.
    const sessions = [sess("a"), sess("b")];
    const h1 = harness({ sessions, mode: "auto" });
    await new SessionRestoreController(h1.deps).runStartup();
    expect(h1.opened.sort()).toEqual(["a", "b"]);
    const h2 = harness({ sessions, mode: "auto" });
    await new SessionRestoreController(h2.deps).runStartup();
    expect(h2.opened.sort()).toEqual(["a", "b"]);
  });

  it("off: does nothing", async () => {
    const h = harness({ sessions: [sess("a")], mode: "off" });
    await new SessionRestoreController(h.deps).runStartup();
    expect(h.opened).toEqual([]);
  });

  it("never reopens a session the user deliberately dismissed", async () => {
    const h = harness({ sessions: [sess("a"), sess("b")], mode: "auto", ledger: { a: 500 } });
    await new SessionRestoreController(h.deps).runStartup();
    expect(h.opened).toEqual(["b"]);
  });

  it("skips sessions that are still running", async () => {
    const h = harness({ sessions: [sess("a", { alive: true }), sess("b")], mode: "auto" });
    await new SessionRestoreController(h.deps).runStartup();
    expect(h.opened).toEqual(["b"]);
  });

  it("above the cap, auto falls back to a prompt instead of ambushing", async () => {
    const many = Array.from({ length: MAX_AUTO_RESTORE + 1 }, (_, i) => sess(`s${i}`));
    // User dismisses the prompt (no answer) → nothing opens.
    const h = harness({ sessions: many, mode: "auto", infoAnswer: undefined });
    await new SessionRestoreController(h.deps).runStartup();
    expect(h.opened).toEqual([]);
    expect(h.infos.some((m) => new RegExp(`${many.length} interrupted`).test(m))).toBe(true);
  });

  it("prompt + 'Restore all' reopens everything", async () => {
    const h = harness({ sessions: [sess("a"), sess("b")], mode: "prompt", infoAnswer: "Restore all" });
    await new SessionRestoreController(h.deps).runStartup();
    expect(h.opened.sort()).toEqual(["a", "b"]);
  });
});

describe("SessionRestoreController.runManual", () => {
  it("reopens only the picked sessions and ignores the ledger", async () => {
    const a = sess("a");
    const b = sess("b");
    // 'a' is already in the ledger, but manual ignores it; user picks only 'a'.
    const h = harness({ sessions: [a, b], ledger: { a: 500 }, pick: [a] });
    await new SessionRestoreController(h.deps).runManual();
    expect(h.opened).toEqual(["a"]);
  });

  it("tells the user when there is nothing to restore", async () => {
    const h = harness({ sessions: [sess("a", { alive: true })] });
    await new SessionRestoreController(h.deps).runManual();
    expect(h.opened).toEqual([]);
    expect(h.infos.some((m) => /no interrupted sessions/i.test(m))).toBe(true);
  });
});
