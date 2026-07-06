import { describe, it, expect } from "vitest";
import {
  costEventsFrom,
  parseEnvelopeV2,
  diffFrom,
  subagentFrom,
  toolsFrom,
  envFrom,
} from "../../src/envelope";
import { costEnvelope, costRequest, sampleEnrichmentLines, v2Envelope } from "../../dev/fixtures";

describe("parseEnvelopeV2", () => {
  it("parses a v2 envelope's identifiers, raw event, and enrichments", () => {
    const line = v2Envelope("claude-code", "PostToolUse", "2026-07-03T17:00:00Z", {
      sessionId: "s1",
      promptId: "p1",
      raw: { tool_name: "Bash" },
      repo: "promptconduit/cli",
      branch: "feat/x",
    });
    const env = parseEnvelopeV2(line)!;
    expect(env.schema).toBe(2);
    expect(env.sessionId).toBe("s1");
    expect(env.promptId).toBe("p1");
    expect(env.tool).toBe("claude-code");
    expect(env.hookEvent).toBe("PostToolUse");
    expect(env.raw.tool_name).toBe("Bash");
    expect(env.vcs.repo).toBe("promptconduit/cli");
    expect(env.vcs.branch).toBe("feat/x");
    expect(env.trace.trace_id).toBeTruthy();
  });

  it("returns null for blank / whitespace lines", () => {
    expect(parseEnvelopeV2("")).toBeNull();
    expect(parseEnvelopeV2("   ")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseEnvelopeV2("{nope")).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    expect(parseEnvelopeV2("42")).toBeNull();
    expect(parseEnvelopeV2('"str"')).toBeNull();
  });

  it("rejects pre-v2 lines (missing or older schema)", () => {
    expect(parseEnvelopeV2(JSON.stringify({ tool: "cursor", native_payload: {} }))).toBeNull();
    expect(parseEnvelopeV2(JSON.stringify({ schema: 1, tool: "cursor", raw_event: {} }))).toBeNull();
  });

  it("accepts a FUTURE schema (forward-compatible)", () => {
    const line = JSON.stringify({
      schema: 3,
      event_id: "e",
      session_id: "s",
      tool: "cursor",
      hook_event: "stop",
      captured_at: "2026-07-03T17:00:00Z",
      cli_version: "9.9.9",
      raw_event: {},
      enrichments: { some_future_slug: { x: 1 } },
    });
    const env = parseEnvelopeV2(line)!;
    expect(env.schema).toBe(3);
    expect(env.enrichments.some_future_slug).toEqual({ x: 1 });
  });
});

describe("costEventsFrom", () => {
  it("maps the cost enrichment's requests into CostEvent records", () => {
    const line = costEnvelope("claude-code", "2026-07-03T17:00:00Z", "cc-1", [
      costRequest({ request_id: "req-1" }),
      costRequest({ request_id: "req-2", model: "claude-opus-4-8" }),
    ], { raw: { cwd: "/Users/x/proj" } });
    const events = costEventsFrom(parseEnvelopeV2(line)!);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      tool: "claude-code",
      session_id: "cc-1",
      request_id: "req-1",
      model: "claude-4.5-sonnet",
      model_priced: true,
      source: "exact",
      cwd_base: "proj",
    });
    expect(events[0].tokens.input).toBe(8000);
    expect(events[0].cost.total).toBeCloseTo(0.0548, 6);
    expect(events[1].model).toBe("claude-opus-4-8");
  });

  it("carries Cursor's conversation_id from the request", () => {
    const line = costEnvelope("cursor", "2026-07-03T17:00:00Z", "cs-1", [
      costRequest({ request_id: "gen-1", conversation_id: "conv-1" }),
    ]);
    const events = costEventsFrom(parseEnvelopeV2(line)!);
    expect(events[0].conversation_id).toBe("conv-1");
  });

  it("yields nothing for events without a cost slug or without request ids", () => {
    const plain = v2Envelope("claude-code", "PreToolUse", "2026-07-03T17:00:00Z", { sessionId: "s" });
    expect(costEventsFrom(parseEnvelopeV2(plain)!)).toEqual([]);
    const noId = costEnvelope("claude-code", "2026-07-03T17:00:00Z", "s", [costRequest({ request_id: "" })]);
    expect(costEventsFrom(parseEnvelopeV2(noId)!)).toEqual([]);
  });

  it("falls back to the envelope's captured_at when a request has no ts", () => {
    const line = costEnvelope("claude-code", "2026-07-03T17:00:00Z", "s", [costRequest({ request_id: "r" })]);
    const [ev] = costEventsFrom(parseEnvelopeV2(line)!);
    expect(ev.ts).toBe("2026-07-03T17:00:00Z");
  });
});

describe("enrichment slug accessors", () => {
  it("reads diff, subagent, tools, and env slugs", () => {
    for (const line of sampleEnrichmentLines) {
      const env = parseEnvelopeV2(line)!;
      if (env.hookEvent === "Stop") {
        expect(diffFrom(env)).toMatchObject({ files_changed: 3, insertions: 120, deletions: 40 });
      }
      if (env.hookEvent === "SubagentStop" && subagentFrom(env)?.agent_id === "a1") {
        expect(subagentFrom(env)).toMatchObject({
          phase: "stop",
          agent_type: "Explore",
          duration_ms: 95000,
          usd: { total: 0.18 },
        });
      }
      if (env.hookEvent === "PostToolBatch") {
        const tools = toolsFrom(env)!;
        expect(tools.total).toBe(3);
        expect(tools.failed).toBe(1);
        expect(tools.calls?.[1].duration_ms).toBe(1500);
      }
    }
    const envLine = v2Envelope("claude-code", "SessionStart", "2026-07-03T17:00:00Z", {
      sessionId: "s",
      enrichments: { env: { os: "darwin", os_version: "26.1", arch: "arm64" } },
    });
    expect(envFrom(parseEnvelopeV2(envLine)!)!).toMatchObject({ os: "darwin", os_version: "26.1" });
  });

  it("returns undefined for missing slugs", () => {
    const env = parseEnvelopeV2(v2Envelope("cursor", "stop", "2026-07-03T17:00:00Z", { sessionId: "s" }))!;
    expect(diffFrom(env)).toBeUndefined();
    expect(subagentFrom(env)).toBeUndefined();
    expect(toolsFrom(env)).toBeUndefined();
  });
});
