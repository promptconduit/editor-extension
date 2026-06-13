// Mirrors the CLI's cost data contract (cli/internal/cost/event.go). The `v`
// field lets us reject schema drift rather than mis-render it.

export const SCHEMA_VERSION = 1;

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

export interface CostEvent {
  v: number;
  kind: "cost_event";
  tool: string;
  session_id: string;
  request_id: string;
  ts: string;
  model: string;
  model_priced: boolean;
  source: string;
  tokens: Tokens;
  cost: Cost;
  cwd_base: string;
}

export interface ModelTotal {
  model: string;
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
  if (rec.v !== SCHEMA_VERSION) {
    return null; // unknown schema version — ignore rather than mis-render
  }
  if (rec.kind === "cost_event" || rec.kind === "session_summary") {
    return rec as CostRecord;
  }
  return null;
}
