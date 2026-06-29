import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GitHubEnricher, resolveGitHubToken, FetchLike } from "../../src/visualizer/github";
import type { GitHubRefs } from "../../src/visualizer/types";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pc-gh-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function refs(number = 42): GitHubRefs {
  return {
    owner: "o",
    repo: "r",
    repoUrl: "https://github.com/o/r",
    refs: [{ kind: "issue", number, url: `https://github.com/o/r/issues/${number}` }],
  };
}

function jsonResponse(body: unknown, status = 200): ReturnType<FetchLike> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
}

describe("GitHubEnricher", () => {
  it("returns refs unchanged when mode is off or inferOnly", async () => {
    const never: FetchLike = () => {
      throw new Error("should not fetch");
    };
    const off = new GitHubEnricher("off", undefined, never, home);
    const infer = new GitHubEnricher("inferOnly", undefined, never, home);
    expect(await off.enrich(refs())).toEqual(refs());
    expect(await infer.enrich(refs())).toEqual(refs());
  });

  it("fills an issue's title and state", async () => {
    const fetchFn: FetchLike = () => jsonResponse({ title: "A bug", state: "closed" });
    const e = new GitHubEnricher("fetch", undefined, fetchFn, home);
    const out = await e.enrich(refs());
    expect(out.refs[0]).toMatchObject({
      kind: "issue",
      number: 42,
      title: "A bug",
      state: "closed",
      url: "https://github.com/o/r/issues/42",
    });
  });

  it("reclassifies a PR and marks merged + /pull/ url", async () => {
    const fetchFn: FetchLike = () =>
      jsonResponse({ title: "feat: x", state: "closed", pull_request: { merged_at: "2026-01-01T00:00:00Z" } });
    const e = new GitHubEnricher("fetch", undefined, fetchFn, home);
    const out = await e.enrich(refs(7));
    expect(out.refs[0]).toMatchObject({
      kind: "pr",
      number: 7,
      title: "feat: x",
      state: "merged",
      url: "https://github.com/o/r/pull/7",
    });
  });

  it("degrades to the inferred ref on rate limit and stops hammering", async () => {
    let calls = 0;
    const fetchFn: FetchLike = () => {
      calls += 1;
      return jsonResponse({ message: "rate limited" }, 403);
    };
    const e = new GitHubEnricher("fetch", undefined, fetchFn, home);
    const input: GitHubRefs = {
      owner: "o",
      repo: "r",
      repoUrl: "https://github.com/o/r",
      refs: [
        { kind: "issue", number: 1, url: "https://github.com/o/r/issues/1" },
        { kind: "issue", number: 2, url: "https://github.com/o/r/issues/2" },
      ],
    };
    const out = await e.enrich(input);
    expect(out.refs).toEqual(input.refs); // unchanged
    expect(calls).toBe(1); // gave up after the first 403
  });

  it("degrades when the network throws (offline)", async () => {
    const fetchFn: FetchLike = () => Promise.reject(new Error("ENOTFOUND"));
    const e = new GitHubEnricher("fetch", undefined, fetchFn, home);
    const out = await e.enrich(refs());
    expect(out.refs[0].title).toBeUndefined();
    expect(out.refs[0].url).toBe("https://github.com/o/r/issues/42");
  });

  it("caches in memory so repeat lookups don't refetch", async () => {
    let calls = 0;
    const fetchFn: FetchLike = () => {
      calls += 1;
      return jsonResponse({ title: "cached", state: "open" });
    };
    const e = new GitHubEnricher("fetch", undefined, fetchFn, home);
    await e.enrich(refs());
    await e.enrich(refs());
    expect(calls).toBe(1);
  });
});

describe("resolveGitHubToken", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it("prefers the configured token, then env, then undefined", () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    expect(resolveGitHubToken("cfgtoken")).toBe("cfgtoken");
    expect(resolveGitHubToken("  ")).toBeUndefined();
    process.env.GITHUB_TOKEN = "envtoken";
    expect(resolveGitHubToken(undefined)).toBe("envtoken");
  });
});
