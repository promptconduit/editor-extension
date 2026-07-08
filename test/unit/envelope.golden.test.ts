import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseEnvelopeV2,
  costEventsFrom,
  diffFrom,
  subagentFrom,
  toolsFrom,
  envFrom,
} from "../../src/envelope";

// Canonical cross-repo contract sample. Source of truth:
// cli/internal/envelope/testdata/envelope.golden.json; this is a byte-identical
// mirror (kept additive-only, alongside the platform copy). This guard fails if
// the extension's tolerant reader can no longer surface the slugs its panels
// render from the real wire shape — i.e. if the mirror has drifted from the CLI.
const golden = readFileSync(
  new URL("../fixtures/envelope.golden.json", import.meta.url),
  "utf8",
);

describe("v2 envelope contract (golden)", () => {
  const env = parseEnvelopeV2(golden);

  it("parses the canonical envelope", () => {
    expect(env).not.toBeNull();
    expect(env!.schema).toBe(2);
    expect(env!.sessionId).toBe("sess-abc123");
    expect(env!.promptId).toBe("prompt-xyz789");
    expect(env!.tool).toBe("claude-code");
    expect(env!.hookEvent).toBe("Stop");
    expect(env!.raw.cwd).toBe("/Users/dev/project");
  });

  it("flattens the nested vcs + trace enrichments", () => {
    expect(env!.vcs.repo).toBe("promptconduit/cli");
    expect(env!.vcs.commit_hash).toBe("d2065769abcdef");
    expect(env!.vcs.is_worktree).toBe(true);
    expect(env!.vcs.worktree_path).toBe("/Users/dev/promptconduit-worktrees/feat-x");
    expect(env!.vcs.pr?.number).toBe(42);
    expect(env!.trace.trace_id).toBe("0af7651916cd43dd8448eb211c80319c");
  });

  it("surfaces the cost/diff/tools/subagent/env slugs the panels read", () => {
    const costs = costEventsFrom(env!);
    expect(costs).toHaveLength(1);
    expect(costs[0].request_id).toBe("req-1");
    expect(costs[0].cost.total).toBeCloseTo(0.0315);
    expect(diffFrom(env!)?.files_changed).toBe(3);
    expect(toolsFrom(env!)?.total).toBe(3);
    expect(subagentFrom(env!)?.agent_type).toBe("Explore");
    expect(envFrom(env!)?.os).toBe("darwin");
  });
});
