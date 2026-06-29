// The scene's own immersive dark palette (DOM chrome uses --vscode-* vars; the
// 3D world is its own thing). Values mirror the plan's signature palette.
import type { NodeKind, ToolClass } from "../src/visualizer/types";

export const COLORS = {
  bg: 0x05070d,
  session: 0x38e1ff, // cyan — the session/you
  agent: 0xffb454, // amber — the lead agent
  subagent: 0xa78bfa, // violet — spawned sub-agents
  wireBase: 0x15324a, // steady tube glow
  wirePulse: 0x7df9ff, // travelling energy band
  file: 0x4ade80, // green — local file
  web: 0x38bdf8, // cyan — web/url
  cloud: 0xe879f9, // magenta — cloud / MCP
  shell: 0xfbbf24, // amber — shell burst
  spawn: 0xa78bfa,
  other: 0x94a3b8,
  cloudCore: 0xbaf7ff,
  cloudHalo: 0x1b9aaa,
} as const;

export function nodeColor(kind: NodeKind): number {
  if (kind === "session") return COLORS.session;
  if (kind === "agent") return COLORS.agent;
  return COLORS.subagent;
}

export function toolColor(cls: ToolClass): number {
  return (COLORS as Record<string, number>)[cls] ?? COLORS.other;
}
