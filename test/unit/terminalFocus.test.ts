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
