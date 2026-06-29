// Pure helpers: classify a tool call into a visual class, summarize it for the
// hover/HUD, and best-effort infer GitHub issue/PR refs from git context. No
// Node imports — safe to bundle into the webview if ever needed.
import type { ToolClass, GitHubRefs, GitHubRef } from "./types";
import type { GitContext } from "./envelope";

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);

/** Map a tool name to the visual lane the call travels in. */
export function classifyTool(toolName: string): ToolClass {
  if (!toolName) return "other";
  if (toolName.startsWith("mcp__")) return "cloud";
  if (toolName === "Task") return "spawn";
  if (toolName === "Bash") return "shell";
  if (FILE_TOOLS.has(toolName)) return "file";
  if (WEB_TOOLS.has(toolName)) return "web";
  return "other";
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asObj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** A short headline + target (url / file path / mcp server) for a tool call. */
export function describeToolCall(
  toolName: string,
  input: unknown,
): { headline: string; target?: string } {
  const cls = classifyTool(toolName);
  const inp = asObj(input);
  switch (cls) {
    case "web": {
      const url = asStr(inp.url) || asStr(inp.query) || asStr(inp.prompt);
      return { headline: toolName, target: url || undefined };
    }
    case "file": {
      const fp = asStr(inp.file_path) || asStr(inp.path) || asStr(inp.notebook_path);
      return { headline: toolName, target: fp || undefined };
    }
    case "shell": {
      const cmd = asStr(inp.command);
      return { headline: "Bash", target: cmd ? cmd.split("\n")[0].slice(0, 80) : undefined };
    }
    case "cloud": {
      // mcp__<server>__<tool>
      const parts = toolName.split("__");
      const server = parts.length >= 2 ? parts[1] : "";
      return { headline: parts.slice(2).join("__") || toolName, target: server || undefined };
    }
    case "spawn": {
      const desc = asStr(inp.description) || asStr(inp.subagent_type);
      return { headline: "Task", target: desc || undefined };
    }
    default:
      return { headline: toolName || "tool" };
  }
}

/** Parse "owner/repo" from a git remote (git@ or https, with/without .git). */
export function parseRemote(remoteUrl: string): { owner: string; repo: string } | null {
  if (!remoteUrl) return null;
  const m = remoteUrl.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

// Ordered so the most specific intent ("Closes #12") is found, but every match
// just contributes a candidate number — the host enrichment decides issue vs PR.
const REF_PATTERNS: RegExp[] = [
  /\b(?:closes|fixes|resolves)\s+#(\d+)/gi,
  /\bPC-(\d+)/gi,
  /\b(?:feat|fix|chore|refactor|docs)\/(\d+)-/gi,
  /#(\d+)/g,
];

/**
 * Best-effort GitHub refs from branch + commit message. Numbers can't be told
 * apart as issue vs PR from text alone, so each is emitted as an "issue"
 * candidate with an /issues/<n> URL (GitHub redirects that to /pull/<n> for PRs);
 * host-side enrichment reclassifies and fills titles. Degrades to repo-only.
 */
export function inferGitHubRefs(git: GitContext): GitHubRefs {
  const out: GitHubRefs = { refs: [] };
  const remote = parseRemote(git.remote_url ?? "");
  if (remote) {
    out.owner = remote.owner;
    out.repo = remote.repo;
    out.repoUrl = `https://github.com/${remote.owner}/${remote.repo}`;
  }

  const numbers = new Set<number>();
  for (const text of [git.branch ?? "", git.commit_message ?? ""]) {
    for (const re of REF_PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > 0 && n < 1_000_000) numbers.add(n);
      }
    }
  }

  for (const n of [...numbers].sort((a, b) => a - b)) {
    const ref: GitHubRef = {
      kind: "issue",
      number: n,
      url: out.repoUrl ? `${out.repoUrl}/issues/${n}` : "",
    };
    out.refs.push(ref);
  }
  return out;
}
