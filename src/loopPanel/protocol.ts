// Message contract between the extension host and The Loop webview. Type-only
// on both sides; everything in LoopPanelState must survive JSON serialization.

import type { Advice, LoopLedger, SessionOpening } from "../loop/ledger";
import type { HistoryView } from "../loop/history";
import type { TaskKind } from "../loop/taskKind";
import type { FocusSource } from "../state";
import type { SetupState } from "../setup";

/** One prompt in the session's prompt list. */
export interface LoopPromptRow {
  id: string;
  text: string;
  ts?: string;
  usd: number;
  roundTrips: number;
  kind: TaskKind;
  /** Still running (no Stop yet). */
  live: boolean;
}

/** One model call in the session-growth chart: [ts, context, usd, reread$, write$, output$]. */
export type GrowthPoint = [string, number, number, number, number, number];

export interface LoopSession {
  key: string;
  tool: string;
  /** "repo · branch" when known. */
  where?: string;
  totalUsd: number;
  /** Newest first. */
  prompts: LoopPromptRow[];
  growth: GrowthPoint[];
  /** Prompt start markers for the growth chart: [ts, promptId]. */
  promptMarks: [string, string][];
  opening?: SessionOpening;
}

/** Local 30-day API-equivalent spend, shown as the reason to sign in. */
export interface SyncOffer {
  usd: number;
  sessions: number;
  windowDays: number;
}

export interface LoopPanelState {
  revision: number;
  focusSource: FocusSource;
  session?: LoopSession;
  selectedPromptId?: string;
  /** True when the panel follows the newest prompt instead of a picked one. */
  followLatest: boolean;
  promptText?: string;
  ledger?: LoopLedger;
  advice: (Advice & { guideUrl?: string })[];
  history?: HistoryView;
  /** Local 30-day spend shown as the reason to sign in, when not syncing. */
  syncOffer?: SyncOffer;
  /** Base URL for coaching guides and the web app (UTM-tagged by the host). */
  guideBase: string;
  teamUrl: string;
  /** The CLI is signed in and syncing: team comparison and invites work. */
  signedIn: boolean;
  /** "Ask your agent": MCP registration status for this editor's agent. */
  agentHint?: AgentHint;
  /** First-run guidance until the CLI is installed and has recorded something. */
  setup?: SetupState;
  /** Subagents the selected prompt ran, which have their own context and cost. */
  subagents?: { count: number; usd: number; unpricedRequests: number };
}

/** MCP registration for this editor's agent, plus example questions to ask it. */
export interface AgentHint {
  /** MCP install name: cursor, claude-code. */
  tool: string;
  label: string;
  registered: boolean;
  /** Other agents that already have the server (labels). */
  otherRegistered: string[];
  /** Signed in to the platform: team questions and invites work. */
  signedIn: boolean;
  questions: string[];
}

export type HostMessage =
  | { type: "state"; state: LoopPanelState }
  | { type: "visibility"; visible: boolean };

export type WebviewCommand =
  | "pinSession"
  | "followActive"
  | "refresh"
  | "login"
  | "dismissLogin"
  | "followLatest"
  | "registerMcp"
  | "dismissAgentHint"
  | "inviteTeammate"
  | "installCli"
  | "runInit";

export type WebviewMessage =
  | { type: "ready" }
  | { type: "selectPrompt"; promptId: string }
  | { type: "open_external"; url: string }
  | { type: "command"; id: WebviewCommand }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string };
