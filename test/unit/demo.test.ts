import { describe, it, expect } from "vitest";
import { demoScene } from "../../src/visualizer/demo";

describe("demoScene", () => {
  it("is deterministic", () => {
    expect(demoScene()).toEqual(demoScene());
  });

  it("has a lead agent and at least one sub-agent", () => {
    const { graph } = demoScene();
    expect(graph.nodes.find((n) => n.kind === "agent")).toBeDefined();
    expect(graph.nodes.filter((n) => n.kind === "subagent").length).toBeGreaterThanOrEqual(1);
  });

  it("exercises every tool class", () => {
    const { graph } = demoScene();
    const classes = new Set(graph.toolCalls.map((c) => c.cls));
    for (const cls of ["file", "shell", "web", "cloud"]) {
      expect(classes, `expected a ${cls} tool call`).toContain(cls);
    }
  });

  it("ships rich GitHub refs (titles + a merged PR) for the hover card", () => {
    const { graph } = demoScene();
    const refs = graph.nodes[0].github?.refs ?? [];
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((r) => r.title)).toBe(true);
    expect(refs.some((r) => r.kind === "pr" && r.state === "merged")).toBe(true);
  });

  it("produces a non-trivial, sorted timeline", () => {
    const { timeline } = demoScene();
    expect(timeline.events.length).toBeGreaterThan(5);
    const ts = timeline.events.map((e) => e.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });
});
