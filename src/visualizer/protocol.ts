// The postMessage contract between the extension host and the webview. Pure
// type-only module imported by both sides (`import type`), so it has no runtime
// footprint and is safe in the esbuild webview bundle. Designed for v1 playback
// AND a future live mode: `graph_patch` and `visibility` already exist so live
// is purely additive.
import type { Scene } from "./types";

export type PlaybackMode = "playback" | "live";

export type HostMessage =
  | { type: "load"; scene: Scene; mode: PlaybackMode; reducedMotion: boolean; isDemo: boolean }
  | { type: "graph_patch"; scene: Scene } // v2: re-snapshot from the live tail
  | { type: "transport"; action: "play" | "pause" | "seek" | "speed"; value?: number }
  | { type: "visibility"; visible: boolean };

export type WebviewMessage =
  | { type: "ready" } // bundle booted; host responds with `load`
  | { type: "scene_ready" } // first frame rendered (E2E marker)
  | { type: "open_external"; url: string }
  | { type: "log"; level: "log" | "warn" | "error"; msg: string };
