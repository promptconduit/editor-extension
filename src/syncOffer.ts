// Decides when the cost panel should offer `promptconduit login`. The offer
// appears after LOGIN_CTA_MIN_SESSIONS priced sessions in the last 30 days,
// and stays hidden once the CLI is syncing or the user dismisses it.

import * as vscode from "vscode";
import { readCloudSyncEnabled } from "./cloudAccount";
import {
  LOGIN_CTA_MIN_SESSIONS,
  MONTH_WINDOW_DAYS,
  readMonthSpend,
} from "./monthSpend";
import type { SyncOffer } from "./costPanel/protocol";

const DISMISS_KEY = "promptconduit.loginCta.dismissed";

/** Quote a binary path for a terminal command. Bare names and simple paths stay bare. */
export function shellQuote(bin: string): string {
  if (/^[A-Za-z0-9_./:+@=-]+$/.test(bin)) {
    return bin;
  }
  return `'${bin.replace(/'/g, `'\\''`)}'`;
}

export class SyncOfferController {
  private offer: SyncOffer | undefined;
  private onChange: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  current(): SyncOffer | undefined {
    return this.offer;
  }

  setOnChange(fn: () => void): void {
    this.onChange = fn;
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, 60_000);
  }

  dismiss(): void {
    void this.context.globalState.update(DISMISS_KEY, true);
    this.offer = undefined;
    this.onChange?.();
  }

  async refresh(): Promise<void> {
    const next = await this.compute();
    const prev = this.offer;
    const same =
      prev?.usd === next?.usd &&
      prev?.sessions === next?.sessions &&
      (prev === undefined) === (next === undefined);
    this.offer = next;
    if (!same) {
      this.onChange?.();
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async compute(): Promise<SyncOffer | undefined> {
    if (this.context.globalState.get<boolean>(DISMISS_KEY, false)) {
      return undefined;
    }
    if (readCloudSyncEnabled()) {
      return undefined;
    }
    const spend = await readMonthSpend();
    if (spend.sessions < LOGIN_CTA_MIN_SESSIONS || spend.usd <= 0) {
      return undefined;
    }
    return { usd: spend.usd, sessions: spend.sessions, windowDays: MONTH_WINDOW_DAYS };
  }
}
