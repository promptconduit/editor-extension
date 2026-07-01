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
  ledger: Record<string, number>;
  infos: string[]; // messages shown
}

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
    writeLedger: async (l) => {
      for (const k of Object.keys(ledger)) delete ledger[k];
      Object.assign(ledger, l);
    },
    now: () => 1_000,
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
  it("auto: silently reopens interrupted sessions and records them in the ledger", async () => {
    const h = harness({ sessions: [sess("a"), sess("b")], mode: "auto" });
    await new SessionRestoreController(h.deps).runStartup();
    expect(h.opened.sort()).toEqual(["a", "b"]);
    expect(Object.keys(h.ledger).sort()).toEqual(["a", "b"]);
    expect(h.infos.some((m) => /reopened 2/i.test(m))).toBe(true);
  });

  it("off: does nothing", async () => {
    const h = harness({ sessions: [sess("a")], mode: "off" });
    await new SessionRestoreController(h.deps).runStartup();
    expect(h.opened).toEqual([]);
  });

  it("never reopens a session already in the ledger", async () => {
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
