// Tolerant, defensive view of the CLI's v2 event envelope: every accessor is
// guarded so one malformed field never throws, and a bad line yields null
// rather than aborting a stream. Pre-v2 lines are skipped.
// See cli/internal/envelope/envelope.go.

export interface GitContext {
  repo_name?: string;
  branch?: string;
  commit_hash?: string;
  commit_message?: string;
  remote_url?: string;
}

export interface Correlation {
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
}

/** One tool call: a single Pre/PostToolUse, or one element of a PostToolBatch. */
export interface NativeToolCall {
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
}

export interface NativePayload {
  session_id?: string;
  hook_event_name?: string;
  model?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  tool_calls?: unknown; // PostToolBatch array (validated in toolCallsOf)
  agent_id?: string;
  agent_type?: string;
  cwd?: string;
  [k: string]: unknown;
}

export interface RawEnvelope {
  tool: string;
  hookEvent: string;
  capturedAt: string;
  native: NativePayload;
  git: GitContext;
  correlation: Correlation;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/**
 * Parse one JSONL line into a RawEnvelope. Returns null for blanks, malformed
 * JSON, or non-object lines so a single bad line never breaks ingestion.
 */
export function parseEnvelope(line: string): RawEnvelope | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.schema !== "number" || rec.schema < 2) return null; // pre-v2 line

  const enrichments = obj(rec.enrichments);
  const vcs = obj(enrichments.vcs);
  const commit = obj(vcs.commit);
  const corrSrc = obj(enrichments.trace);
  const native = obj(rec.raw_event) as NativePayload;
  // Keep the envelope's lifted session_id reachable through the native view
  // (older consumers read native.session_id).
  if (!native.session_id && typeof rec.session_id === "string") {
    native.session_id = rec.session_id;
  }

  return {
    tool: str(rec.tool),
    hookEvent: str(rec.hook_event),
    capturedAt: str(rec.captured_at),
    native,
    git: {
      repo_name: str(vcs.repo) || undefined,
      branch: str(vcs.branch) || undefined,
      commit_hash: str(commit.hash) || undefined,
      commit_message: str(commit.message) || undefined,
      remote_url: str(vcs.remote_url) || undefined,
    },
    correlation: {
      trace_id: str(corrSrc.trace_id) || undefined,
      span_id: str(corrSrc.span_id) || undefined,
      parent_span_id: str(corrSrc.parent_span_id) || undefined,
    },
  };
}

/**
 * Normalize the single- and batched-tool-call shapes into one flat list. Claude
 * Code emits both `PostToolBatch` (native_payload.tool_calls[]) and the single
 * `Pre/PostToolUse` shape; callers shouldn't have to care which.
 */
export function toolCallsOf(env: RawEnvelope): NativeToolCall[] {
  const n = env.native;
  if (Array.isArray(n.tool_calls)) {
    return (n.tool_calls as unknown[])
      .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
      .map((c) => ({
        tool_name: str(c.tool_name),
        tool_input: c.tool_input,
        tool_response: c.tool_response,
        tool_use_id: str(c.tool_use_id) || undefined,
      }));
  }
  if (str(n.tool_name)) {
    return [
      {
        tool_name: str(n.tool_name),
        tool_input: n.tool_input,
        tool_response: n.tool_response,
        tool_use_id: str(n.tool_use_id) || undefined,
      },
    ];
  }
  return [];
}
