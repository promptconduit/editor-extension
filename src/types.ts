// Mirrors the CLI's cost data contract (cli/internal/cost/event.go).
//
// Versioning & forward-compatibility:
// The CLI stamps every record with `v`. The CLI auto-updates, so it will often
// run AHEAD of this extension — if we hard-rejected any version we didn't author
// against, a newer CLI would silently blank the panel. The cost-feed contract is
// ADDITIVE-ONLY (new fields are added with omitempty; existing field meanings
// never change without a major bump), so instead we accept any record with
// `v >= MIN_SCHEMA` and read fields defensively (every new field is optional and
// guarded). That keeps a v3+/vN CLI readable here. SCHEMA_VERSION is simply the
// newest version this build fully understands; bump it (and add the fields) when
// you teach the extension new fields. If the contract ever makes a BREAKING
// change, raise MIN_SCHEMA to gate it.

export const SCHEMA_VERSION = 2; // newest version this build fully understands
export const MIN_SCHEMA = 1; // oldest version we still read

export interface Tokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface Cost {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total: number;
  currency: string;
}

// ToolSummary: content-free per-request tool-call summary (names only; v2+).
// `by_name` is omitted when no tools ran or names aren't derivable (Cursor).
export interface ToolSummary {
  total: number;
  by_name?: Record<string, number>;
}

export type ModelTier = "premium" | "standard" | "economy" | "unknown";

// Signals: derived cost-reduction metrics computed by the CLI (numbers only;
// v2+). On a CostEvent they describe one request; on a SessionSummary they are
// recomputed from the session's accumulated totals.
export interface Signals {
  cache_hit_rate: number; // [0,1] cache_read / (cache_read + cache_write + input)
  cache_miss_cost_share: number; // [0,1] (input$ + cache_write$) / total$
  input_token_share: number; // [0,1] fresh input / all input-side tokens
  tier: ModelTier | string;
  model_priced: boolean;
  tool_calls: number;
}

export interface CostEvent {
  v: number;
  kind: "cost_event";
  tool: string;
  session_id: string;
  conversation_id?: string; // Cursor per-tab key; absent for Claude Code (v2+)
  request_id: string;
  ts: string;
  model: string;
  model_priced: boolean;
  source: string;
  tokens: Tokens;
  cost: Cost;
  cwd_base: string;
  tools?: ToolSummary; // v2+
  signals?: Signals; // v2+
}

export interface ModelTotal {
  model: string;
  model_priced: boolean;
  tokens: Tokens;
  cost_total: number;
}

export interface SessionTotal {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_total: number;
  currency: string;
}

export interface SessionSummary {
  v: number;
  kind: "session_summary";
  session_id: string;
  tool: string;
  source: string;
  started_at: string;
  updated_at: string;
  totals: SessionTotal;
  by_model: ModelTotal[];
  tools?: ToolSummary; // v2+
  signals?: Signals; // v2+
}

export type CostRecord = CostEvent | SessionSummary;

export function parseRecord(line: string): CostRecord | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) {
    return null;
  }
  const rec = obj as Partial<CostRecord>;
  // Accept any known-or-newer additive version; reject only missing/older shapes
  // we can't safely read. New fields beyond SCHEMA_VERSION are simply ignored.
  if (typeof rec.v !== "number" || rec.v < MIN_SCHEMA) {
    return null;
  }
  if (rec.kind === "cost_event" || rec.kind === "session_summary") {
    return rec as CostRecord;
  }
  return null;
}
