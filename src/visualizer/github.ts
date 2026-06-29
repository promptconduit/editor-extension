// Host-side GitHub enrichment. Inferred issue/PR numbers (classify.ts) carry no
// title or state; this fetches them from the public GitHub API so hover cards
// can show real context. Runs in the extension host (Node) — never the webview —
// so the scene stays CSP-locked and the single network egress point respects the
// `promptconduit.visualizer.githubEnrichment` setting.
//
// Privacy: the only thing sent is `owner/repo/number` for the current repo. None
// of your code, prompts, or events leave the machine. Degrades cleanly: a failed
// or rate-limited fetch falls back to inference-only refs (numbers + URLs).
import * as fs from "fs";
import * as path from "path";
import { eventsDir } from "./paths";
import type { GitHubRef, GitHubRefs } from "./types";

export type EnrichmentMode = "fetch" | "inferOnly" | "off";

/** Minimal fetch surface so tests can inject a stub. Matches global `fetch`. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

interface CacheEntry extends GitHubRef {
  fetchedAt: number;
}

const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // a day is plenty for titles/state

export class GitHubEnricher {
  private mem = new Map<string, CacheEntry>(); // key: owner/repo#number
  private cacheFile: string;
  private loaded = false;
  private rateLimited = false;

  constructor(
    private readonly mode: EnrichmentMode,
    private readonly token: string | undefined,
    private readonly fetchFn: FetchLike | undefined = globalThisFetch(),
    home?: string,
  ) {
    this.cacheFile = path.join(eventsDir(home), "cache", "github-refs.json");
  }

  /**
   * Return refs with titles/state filled in where possible. Never throws — on
   * any failure the original (inferred) ref is returned unchanged.
   */
  async enrich(refs: GitHubRefs): Promise<GitHubRefs> {
    if (this.mode !== "fetch" || !refs.owner || !refs.repo || !this.fetchFn) {
      return refs;
    }
    this.loadCache();
    const owner = refs.owner;
    const repo = refs.repo;
    const out: GitHubRef[] = [];
    for (const ref of refs.refs) {
      out.push(await this.lookup(owner, repo, ref));
    }
    this.saveCache();
    return { ...refs, refs: out };
  }

  private async lookup(owner: string, repo: string, ref: GitHubRef): Promise<GitHubRef> {
    const key = `${owner}/${repo}#${ref.number}`;
    const cached = this.mem.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      const { fetchedAt, ...rest } = cached;
      void fetchedAt;
      return rest;
    }
    if (this.rateLimited) return ref; // stop hammering once throttled

    // The /issues/{n} endpoint serves issues AND PRs; a `pull_request` field
    // marks PRs, letting us reclassify and pick the right URL.
    const api = `https://api.github.com/repos/${owner}/${repo}/issues/${ref.number}`;
    try {
      const res = await this.fetchFn!(api, { headers: this.headers() });
      if (res.status === 403 || res.status === 429) {
        this.rateLimited = true;
        return ref;
      }
      if (!res.ok) return ref; // 404 etc. — keep the inferred ref
      const body = (await res.json()) as Record<string, unknown>;
      const isPr = typeof body.pull_request === "object" && body.pull_request !== null;
      const title = typeof body.title === "string" ? body.title : undefined;
      const rawState = typeof body.state === "string" ? body.state : undefined;
      const merged = isPr && pullMerged(body);
      const enriched: GitHubRef = {
        kind: isPr ? "pr" : "issue",
        number: ref.number,
        url: isPr
          ? `https://github.com/${owner}/${repo}/pull/${ref.number}`
          : `https://github.com/${owner}/${repo}/issues/${ref.number}`,
        title,
        state: merged ? "merged" : rawState,
      };
      this.mem.set(key, { ...enriched, fetchedAt: Date.now() });
      return enriched;
    } catch {
      return ref; // offline / DNS / abort — degrade to the inferred ref
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "promptconduit-extension",
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private loadCache(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const data = JSON.parse(fs.readFileSync(this.cacheFile, "utf8")) as Record<string, CacheEntry>;
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v.number === "number") this.mem.set(k, v);
      }
    } catch {
      // No cache yet, or corrupt — start fresh.
    }
  }

  private saveCache(): void {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const obj: Record<string, CacheEntry> = {};
      for (const [k, v] of this.mem) obj[k] = v;
      fs.writeFileSync(this.cacheFile, JSON.stringify(obj), "utf8");
    } catch {
      // Best-effort cache; failure to persist is non-fatal.
    }
  }
}

function pullMerged(body: Record<string, unknown>): boolean {
  const pr = body.pull_request as Record<string, unknown> | undefined;
  return !!pr && typeof pr.merged_at === "string" && pr.merged_at.length > 0;
}

/** The platform's global fetch when present (Node 18+/Electron); else undefined. */
function globalThisFetch(): FetchLike | undefined {
  const f = (globalThis as { fetch?: unknown }).fetch;
  return typeof f === "function" ? (f as FetchLike) : undefined;
}

/** Resolve the GitHub token from an explicit setting or the environment. */
export function resolveGitHubToken(configured: string | undefined): string | undefined {
  const t = (configured || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  return t || undefined;
}
