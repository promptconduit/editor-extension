import { describe, it, expect } from "vitest";
import {
  parseUpdateMarker,
  isNewerVersion,
  shouldPromptReload,
  nextPromptVersion,
} from "../../src/updatePrompt";

describe("parseUpdateMarker", () => {
  it("parses a well-formed marker", () => {
    const m = parseUpdateMarker(
      JSON.stringify({ version: "0.9.0", editor: "Cursor", updated_at: "2026-07-01T00:00:00Z" }),
    );
    expect(m).toEqual({ version: "0.9.0", editor: "Cursor", updated_at: "2026-07-01T00:00:00Z" });
  });

  it("keeps version but tolerates missing optional fields", () => {
    expect(parseUpdateMarker(JSON.stringify({ version: "1.0.0" }))).toEqual({
      version: "1.0.0",
      editor: undefined,
      updated_at: undefined,
    });
  });

  it("trims whitespace around the version", () => {
    expect(parseUpdateMarker(JSON.stringify({ version: "  1.2.3 " }))?.version).toBe("1.2.3");
  });

  it("returns null for invalid JSON", () => {
    expect(parseUpdateMarker("{not json")).toBeNull();
    expect(parseUpdateMarker("")).toBeNull();
  });

  it("returns null when version is missing, empty, or not a string", () => {
    expect(parseUpdateMarker(JSON.stringify({ editor: "Cursor" }))).toBeNull();
    expect(parseUpdateMarker(JSON.stringify({ version: "" }))).toBeNull();
    expect(parseUpdateMarker(JSON.stringify({ version: 9 }))).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    expect(parseUpdateMarker("42")).toBeNull();
    expect(parseUpdateMarker("null")).toBeNull();
    expect(parseUpdateMarker('"0.9.0"')).toBeNull();
  });
});

describe("isNewerVersion", () => {
  it("is true only when strictly greater", () => {
    expect(isNewerVersion("0.9.0", "0.8.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.8.1", "0.8.0")).toBe(true);
  });

  it("is false for equal versions (update already applied)", () => {
    expect(isNewerVersion("0.8.0", "0.8.0")).toBe(false);
  });

  it("is false for older versions (a downgrade must not prompt)", () => {
    expect(isNewerVersion("0.7.0", "0.8.0")).toBe(false);
    expect(isNewerVersion("0.8.0", "0.8.1")).toBe(false);
  });

  it("is false for malformed versions (conservative)", () => {
    expect(isNewerVersion("0.9", "0.8.0")).toBe(false);
    expect(isNewerVersion("v0.9.0", "0.8.0")).toBe(false);
    expect(isNewerVersion("0.9.0-beta", "0.8.0")).toBe(false);
    expect(isNewerVersion("", "0.8.0")).toBe(false);
  });
});

describe("shouldPromptReload", () => {
  it("prompts when the marker is newer than the running version", () => {
    expect(shouldPromptReload("0.8.0", { version: "0.9.0" })).toBe(true);
  });

  it("does not prompt on equal or older, or a null marker", () => {
    expect(shouldPromptReload("0.8.0", { version: "0.8.0" })).toBe(false);
    expect(shouldPromptReload("0.8.0", { version: "0.7.0" })).toBe(false);
    expect(shouldPromptReload("0.8.0", null)).toBe(false);
  });
});

describe("nextPromptVersion (prompt at most once per version)", () => {
  it("returns the newer version when nothing was prompted yet", () => {
    expect(nextPromptVersion("0.8.0", { version: "0.9.0" }, undefined)).toBe("0.9.0");
  });

  it("returns null once that version has already been offered this session", () => {
    expect(nextPromptVersion("0.8.0", { version: "0.9.0" }, "0.9.0")).toBeNull();
  });

  it("re-prompts when a still-newer version lands after an earlier prompt", () => {
    expect(nextPromptVersion("0.8.0", { version: "0.10.0" }, "0.9.0")).toBe("0.10.0");
  });

  it("returns null when there is nothing newer to apply", () => {
    expect(nextPromptVersion("0.9.0", { version: "0.9.0" }, undefined)).toBeNull();
    expect(nextPromptVersion("0.9.0", null, undefined)).toBeNull();
  });
});
