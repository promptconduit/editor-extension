import { describe, it, expect } from "vitest";
import { parseRecord, MIN_SCHEMA } from "../../src/types";
import { heavySummary, sampleEvents } from "../../dev/fixtures";

describe("parseRecord", () => {
  it("parses a valid cost_event", () => {
    const rec = parseRecord(JSON.stringify(sampleEvents[0]));
    expect(rec?.kind).toBe("cost_event");
    expect((rec as any).request_id).toBe("a1");
  });

  it("parses a valid session_summary", () => {
    const rec = parseRecord(JSON.stringify(heavySummary));
    expect(rec?.kind).toBe("session_summary");
  });

  it("returns null for blank / whitespace lines", () => {
    expect(parseRecord("")).toBeNull();
    expect(parseRecord("   \n")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseRecord("{not json")).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    expect(parseRecord("42")).toBeNull();
    expect(parseRecord("null")).toBeNull();
    expect(parseRecord('"a string"')).toBeNull();
  });

  it("rejects records missing a version", () => {
    expect(parseRecord(JSON.stringify({ kind: "cost_event" }))).toBeNull();
  });

  it(`rejects records older than MIN_SCHEMA (${MIN_SCHEMA})`, () => {
    expect(parseRecord(JSON.stringify({ v: MIN_SCHEMA - 1, kind: "cost_event" }))).toBeNull();
  });

  it("rejects unknown kinds even at a valid version", () => {
    expect(parseRecord(JSON.stringify({ v: 2, kind: "something_else" }))).toBeNull();
  });

  it("accepts a FUTURE version (forward-compatible)", () => {
    const rec = parseRecord(JSON.stringify({ v: 99, kind: "cost_event", session_id: "x" }));
    expect(rec?.kind).toBe("cost_event");
  });
});
