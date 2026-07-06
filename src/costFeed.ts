// Cost ingestion from the local event log. Replaces the retired
// `promptconduit cost watch --json` subprocess: per-request costs now arrive
// as the `cost` enrichment on v2 envelopes in ~/.promptconduit/events.jsonl,
// so the extension reads ONE file for every surface.
//
// Does a bounded full-history read first (so session totals survive editor
// restarts), then follows the live tail. Pure fs — no CLI binary required.

import { RawEventTail, logDisabled } from "./tail";
import { costEventsFrom, parseEnvelopeV2, EnvelopeV2 } from "./envelope";
import { CostEvent } from "./types";

export interface CostFeedCallbacks {
  /** Called once per priced request, history first, then live. */
  onEvent: (ev: CostEvent) => void;
  /** Called for every v2 envelope (enrichment slugs beyond cost). */
  onEnvelope?: (env: EnvelopeV2) => void;
  /** Called after the initial full-history read completes. */
  onInitial?: () => void;
}

export class CostFeedController {
  private readonly tail: RawEventTail;
  private disposed = false;

  constructor(private readonly callbacks: CostFeedCallbacks) {
    this.tail = new RawEventTail({ onLines: (lines, initial) => this.ingest(lines, initial) });
  }

  start(): void {
    if (!logDisabled()) {
      this.tail.start();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.tail.dispose();
  }

  private ingest(lines: string[], initial: boolean): void {
    if (this.disposed) {
      return;
    }
    for (const line of lines) {
      const env = parseEnvelopeV2(line);
      if (!env) {
        continue;
      }
      this.callbacks.onEnvelope?.(env);
      for (const ev of costEventsFrom(env)) {
        this.callbacks.onEvent(ev);
      }
    }
    if (initial) {
      this.callbacks.onInitial?.();
    }
  }
}
