// Internal cost model. Since envelope v2 the extension no longer consumes a
// dedicated cost wire feed: per-request costs arrive as the `cost` enrichment
// on ~/.promptconduit/events.jsonl envelopes (see envelope.ts, which maps them
// into these shapes), and session summaries are accumulated locally by
// ConversationStore (state.ts). Field vocabulary mirrors the CLI's
// cli/internal/enrich/cost.go so the mapping stays obvious.

// Source tool of a cost record. The known values mirror the CLI's tool ids;
// the open string keeps autocomplete for those while still accepting any
// future tool the CLI adds without an extension change.
export type ToolId = "claude-code" | "cursor" | (string & {});

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

// ToolSummary: content-free per-request tool-call summary (names only).
// `by_name` is omitted when no tools ran or names aren't derivable (Cursor).
export interface ToolSummary {
  total: number;
  by_name?: Record<string, number>;
}

export type ModelTier = "premium" | "standard" | "economy" | "unknown";

// Signals: derived cost-reduction metrics computed by the CLI (numbers only).
// On a CostEvent they describe one request; on a SessionSummary they are
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
  tool: string;
  session_id: string;
  conversation_id?: string; // Cursor per-tab key; absent for Claude Code
  request_id: string;
  ts: string;
  model: string;
  model_priced: boolean;
  source: string;
  tokens: Tokens;
  cost: Cost;
  cwd_base: string;
  tools?: ToolSummary;
  signals?: Signals;
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
  session_id: string;
  tool: string;
  source: string;
  started_at: string;
  updated_at: string;
  totals: SessionTotal;
  by_model: ModelTotal[];
  tools?: ToolSummary;
  signals?: Signals;
}
