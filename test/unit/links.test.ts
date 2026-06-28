import { describe, it, expect } from "vitest";
import { LINKS, learnMoreLinks, isSafeHttpUrl, ResourceLink } from "../../src/links";

const all: ResourceLink[] = Object.values(LINKS);

describe("links registry", () => {
  it("every link has an https href, a label, and a description", () => {
    for (const link of all) {
      expect(link.href, link.label).toMatch(/^https:\/\//);
      expect(link.label.length).toBeGreaterThan(0);
      expect(link.desc.length).toBeGreaterThan(0);
    }
  });

  it("covers both Claude and Cursor sources", () => {
    const hrefs = all.map((l) => l.href).join(" ");
    expect(hrefs).toMatch(/claude\.com|platform\.claude\.com|code\.claude\.com/);
    expect(hrefs).toMatch(/cursor\.com/);
  });
});

describe("learnMoreLinks", () => {
  it("always includes both tools' resources regardless of active tool", () => {
    for (const tool of ["claude-code", "cursor", undefined] as const) {
      const list = learnMoreLinks(tool);
      const hrefs = list.map((l) => l.href).join(" ");
      expect(hrefs).toContain("cursor.com");
      expect(hrefs, `claude link present for tool=${tool}`).toMatch(/claude\.com/);
      // No duplicates.
      expect(new Set(hrefs.split(" ")).size).toBe(list.length);
    }
  });

  it("leads with the active tool's docs", () => {
    expect(learnMoreLinks("cursor")[0].href).toContain("cursor.com");
    expect(learnMoreLinks("claude-code")[0].href).toMatch(/claude\.com/);
    expect(learnMoreLinks(undefined)[0].href).toMatch(/claude\.com/); // default ordering
  });
});

describe("isSafeHttpUrl", () => {
  it("accepts http(s) and rejects other schemes", () => {
    expect(isSafeHttpUrl("https://example.com")).toBe(true);
    expect(isSafeHttpUrl("http://example.com")).toBe(true);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("data:text/html,<script>")).toBe(false);
    expect(isSafeHttpUrl("vscode://x")).toBe(false);
    expect(isSafeHttpUrl("")).toBe(false);
  });
});
