import { describe, it, expect } from "vitest";
import {
  classifyTool,
  describeToolCall,
  parseRemote,
  inferGitHubRefs,
} from "../../src/visualizer/classify";

describe("classifyTool", () => {
  it("maps file tools", () => {
    for (const t of ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      expect(classifyTool(t)).toBe("file");
    }
  });
  it("maps shell, web, spawn, cloud, other", () => {
    expect(classifyTool("Bash")).toBe("shell");
    expect(classifyTool("WebFetch")).toBe("web");
    expect(classifyTool("WebSearch")).toBe("web");
    expect(classifyTool("Task")).toBe("spawn");
    expect(classifyTool("mcp__github__create_pull_request")).toBe("cloud");
    expect(classifyTool("mcp__context7__query-docs")).toBe("cloud");
    expect(classifyTool("SomethingElse")).toBe("other");
    expect(classifyTool("")).toBe("other");
  });
});

describe("describeToolCall", () => {
  it("extracts a web url", () => {
    expect(describeToolCall("WebFetch", { url: "https://x.dev/a" }).target).toBe("https://x.dev/a");
  });
  it("extracts a file path", () => {
    expect(describeToolCall("Read", { file_path: "src/a.ts" }).target).toBe("src/a.ts");
  });
  it("trims a bash command to its first line", () => {
    const d = describeToolCall("Bash", { command: "npm test\n--watch" });
    expect(d.headline).toBe("Bash");
    expect(d.target).toBe("npm test");
  });
  it("pulls the server + tool from an mcp name", () => {
    const d = describeToolCall("mcp__github__create_pull_request", {});
    expect(d.headline).toBe("create_pull_request");
    expect(d.target).toBe("github");
  });
  it("never throws on non-object input", () => {
    expect(() => describeToolCall("Read", null)).not.toThrow();
    expect(() => describeToolCall("Read", "nope")).not.toThrow();
  });
});

describe("parseRemote", () => {
  it("handles ssh and https, with and without .git", () => {
    expect(parseRemote("git@github.com:promptconduit/cli.git")).toEqual({
      owner: "promptconduit",
      repo: "cli",
    });
    expect(parseRemote("https://github.com/promptconduit/cli.git")).toEqual({
      owner: "promptconduit",
      repo: "cli",
    });
    expect(parseRemote("https://github.com/promptconduit/cli")).toEqual({
      owner: "promptconduit",
      repo: "cli",
    });
  });
  it("returns null for non-github / empty", () => {
    expect(parseRemote("")).toBeNull();
    expect(parseRemote("git@gitlab.com:o/r.git")).toBeNull();
  });
});

describe("inferGitHubRefs", () => {
  it("infers numbers from branch and commit message and builds urls", () => {
    const refs = inferGitHubRefs({
      remote_url: "git@github.com:promptconduit/editor-extension.git",
      branch: "feat/15-theater",
      commit_message: "feat: theater (Closes #42)",
    });
    expect(refs.owner).toBe("promptconduit");
    expect(refs.repo).toBe("editor-extension");
    expect(refs.repoUrl).toBe("https://github.com/promptconduit/editor-extension");
    const numbers = refs.refs.map((r) => r.number).sort((a, b) => a - b);
    expect(numbers).toContain(15);
    expect(numbers).toContain(42);
    for (const r of refs.refs) {
      expect(r.url).toContain("/issues/");
    }
  });
  it("handles PC-style and bare #refs", () => {
    const refs = inferGitHubRefs({
      remote_url: "https://github.com/o/r",
      branch: "main",
      commit_message: "fix PC-7 and #8",
    });
    const nums = refs.refs.map((r) => r.number).sort((a, b) => a - b);
    expect(nums).toEqual([7, 8]);
  });
  it("degrades to empty refs when nothing is inferable", () => {
    const refs = inferGitHubRefs({ remote_url: "git@github.com:o/r.git", branch: "main", commit_message: "tidy up" });
    expect(refs.repoUrl).toBe("https://github.com/o/r");
    expect(refs.refs).toEqual([]);
  });
  it("degrades to no repo url when the remote isn't github", () => {
    const refs = inferGitHubRefs({ branch: "feat/9-x", commit_message: "" });
    expect(refs.repoUrl).toBeUndefined();
    expect(refs.refs.map((r) => r.number)).toEqual([9]);
    expect(refs.refs[0].url).toBe(""); // no repo → no resolvable url
  });
});
