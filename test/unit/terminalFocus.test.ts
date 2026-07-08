import { describe, it, expect } from "vitest";
import { parseResolveJson } from "../../src/terminalFocus";

describe("parseResolveJson", () => {
  it("parses a single resolved session", () => {
    const raw = JSON.stringify({
      session_id: "abc-123",
      tool: "claude-code",
      cwd: "/tmp/proj",
    });
    expect(parseResolveJson(raw)).toEqual({
      session_id: "abc-123",
      tool: "claude-code",
      cwd: "/tmp/proj",
    });
  });

  it("parses ambiguous multi-candidate output", () => {
    const raw = JSON.stringify({
      ambiguous: true,
      candidates: [
        { session_id: "a", pid: "1", cwd: "/x" },
        { session_id: "b", pid: "2", cwd: "/y" },
      ],
    });
    const r = parseResolveJson(raw);
    expect(r.ambiguous).toBe(true);
    expect(r.candidates).toHaveLength(2);
  });

  it("returns empty object on garbage", () => {
    expect(parseResolveJson("not json")).toEqual({});
  });
});

import { TerminalFocusController, TerminalFocusDeps, ResolveCandidate } from "../../src/terminalFocus";
import type * as vscode from "vscode";

function fakeTerminal(pid: number): vscode.Terminal {
  return { processId: Promise.resolve(pid) } as unknown as vscode.Terminal;
}

interface Deferred {
  promise: Promise<string>;
  resolve: (v: string) => void;
}

function deferred(): Deferred {
  let resolve!: (v: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeDeps(
  runResolve: TerminalFocusDeps["runResolve"],
  onFocusChange: TerminalFocusDeps["onFocusChange"],
  pickCandidate?: (c: ResolveCandidate[]) => Promise<string | undefined>,
): TerminalFocusDeps {
  return {
    resolveBinary: () => "promptconduit",
    runResolve,
    pickCandidate: pickCandidate ?? (async () => undefined),
    onFocusChange,
  };
}

describe("TerminalFocusController resolve race", () => {
  it("ignores a slow resolve that finishes after focus moved to another terminal", async () => {
    const slow = deferred();
    const changes: Array<string | undefined> = [];
    const controller = new TerminalFocusController(
      makeDeps(
        (_bin, pid) =>
          pid === 11 ? slow.promise : Promise.resolve(JSON.stringify({ session_id: "session-B" })),
        (key) => changes.push(key),
      ),
    );
    const a = controller.resolveTerminal(fakeTerminal(11)); // slow
    const b = controller.resolveTerminal(fakeTerminal(22)); // fast
    await b;
    slow.resolve(JSON.stringify({ session_id: "session-A" }));
    await a;
    expect(controller.sessionKey).toBe("session-B");
    expect(changes[changes.length - 1]).toBe("session-B");
  });

  it("ignores a stale quick-pick answer after focus moved on", async () => {
    const pick = deferred();
    const changes: Array<string | undefined> = [];
    const controller = new TerminalFocusController(
      makeDeps(
        (_bin, pid) =>
          Promise.resolve(
            pid === 11
              ? JSON.stringify({ ambiguous: true, candidates: [{ session_id: "amb-A" }] })
              : JSON.stringify({ session_id: "session-B" }),
          ),
        (key) => changes.push(key),
        async () => pick.promise as Promise<string | undefined>,
      ),
    );
    const a = controller.resolveTerminal(fakeTerminal(11)); // parks on the picker
    await new Promise((r) => setImmediate(r));
    await controller.resolveTerminal(fakeTerminal(22));
    pick.resolve("amb-A");
    await a;
    expect(controller.sessionKey).toBe("session-B");
  });

  it("still resolves normally with no competing focus change", async () => {
    const controller = new TerminalFocusController(
      makeDeps(
        () => Promise.resolve(JSON.stringify({ session_id: "solo" })),
        () => {},
      ),
    );
    await controller.resolveTerminal(fakeTerminal(7));
    expect(controller.sessionKey).toBe("solo");
  });

  it("clears focus when no terminal is active", async () => {
    const controller = new TerminalFocusController(
      makeDeps(
        () => Promise.resolve(JSON.stringify({ session_id: "x" })),
        () => {},
      ),
    );
    await controller.resolveTerminal(fakeTerminal(7));
    await controller.resolveTerminal(undefined);
    expect(controller.sessionKey).toBeUndefined();
  });
});
