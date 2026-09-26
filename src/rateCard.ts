// Extension-host only. Reads the rate card the CLI downloads. The webview
// never imports this file.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BUNDLED_CARD_UPDATED, type ModelPrice } from "./pricing";

interface RawPrice {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_1h?: number;
}

export function publishedCardPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "promptconduit", "cost", "pricing-card.json");
}

/** Parse a PromptConduit card. Returns undefined when it must not override the bundle. */
export function rateCardFromDocument(
  raw: unknown,
  bundledUpdated = BUNDLED_CARD_UPDATED,
): Record<string, ModelPrice> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const doc = raw as Record<string, unknown>;
  if (doc._source !== "promptconduit" || typeof doc._updated !== "string") {
    return undefined;
  }
  if (doc._updated < bundledUpdated) {
    return undefined;
  }
  const out: Record<string, ModelPrice> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith("_") || !value || typeof value !== "object") {
      continue;
    }
    const row = value as RawPrice;
    const input = row.input_cost_per_token ?? 0;
    const output = row.output_cost_per_token ?? 0;
    if (input === 0 && output === 0) {
      continue;
    }
    const price: ModelPrice = { input, output };
    if (typeof row.cache_read_input_token_cost === "number") {
      price.cacheRead = row.cache_read_input_token_cost;
    }
    if (typeof row.cache_creation_input_token_cost === "number") {
      price.cacheWrite5m = row.cache_creation_input_token_cost;
    }
    if (typeof row.cache_creation_input_token_cost_1h === "number") {
      price.cacheWrite1h = row.cache_creation_input_token_cost_1h;
    }
    out[key] = price;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function readPublishedRateCard(): Record<string, ModelPrice> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(publishedCardPath(), "utf8");
  } catch {
    return undefined;
  }
  try {
    return rateCardFromDocument(JSON.parse(text));
  } catch {
    return undefined;
  }
}
