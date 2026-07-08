import { describe, it, expect } from "vitest";
import { GLOSSARY, glossaryFor, GlossaryEntry } from "../../src/costPanel/glossary";
import { isSafeHttpUrl } from "../../src/links";

const entries: [string, GlossaryEntry][] = Object.entries(GLOSSARY);

describe("glossary entries", () => {
  it("every entry has a non-empty term and short definition", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, entry] of entries) {
      expect(entry.term.trim().length, `${key} term`).toBeGreaterThan(0);
      expect(entry.short.trim().length, `${key} short`).toBeGreaterThan(0);
    }
  });

  it("every href, when set, passes isSafeHttpUrl", () => {
    for (const [key, entry] of entries) {
      if (entry.href !== undefined) {
        expect(isSafeHttpUrl(entry.href), `${key} href: ${entry.href}`).toBe(true);
      }
    }
  });

  it("covers the token buckets and derived ratios", () => {
    for (const key of [
      "input_tokens",
      "output_tokens",
      "cache_read",
      "cache_write",
      "cache_hit_rate",
      "fresh_input_share",
      "tier",
    ]) {
      expect(GLOSSARY[key], key).toBeDefined();
    }
  });

  it("covers every Claude Code permission mode", () => {
    for (const mode of ["plan", "auto", "acceptEdits", "default", "bypassPermissions"]) {
      const key = `permission_mode_${mode}`;
      expect(GLOSSARY[key], key).toBeDefined();
      expect(GLOSSARY[key].href, `${key} links to the permission modes doc`).toContain(
        "permission-modes"
      );
    }
  });

  it("covers session structure and cost provenance keys", () => {
    for (const key of [
      "subagent",
      "mcp_server",
      "model_unpriced",
      "source_exact",
      "source_estimate",
      "source_reconciled",
    ]) {
      expect(GLOSSARY[key], key).toBeDefined();
    }
  });
});

describe("glossaryFor", () => {
  it("returns the entry for a known key", () => {
    expect(glossaryFor("cache_write")).toBe(GLOSSARY.cache_write);
    expect(glossaryFor("subagent")?.term).toBe("Subagent");
  });

  it("returns undefined for unknown keys", () => {
    expect(glossaryFor("nope")).toBeUndefined();
    expect(glossaryFor("")).toBeUndefined();
  });
});
