import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A tiny fake of the webview-panel slice of the vscode API that CostDetailPanel
// uses, so the host's push/visibility/throttle logic can be exercised.
interface FakePanel {
  visible: boolean;
  posted: unknown[];
  viewState: Array<() => void>;
  message?: (msg: unknown) => void;
  reveal: () => void;
  hide: () => void;
}

const fake = vi.hoisted(() => ({ panel: undefined as FakePanel | undefined }));

vi.mock("vscode", () => {
  const createWebviewPanel = () => {
    const p: FakePanel = {
      visible: true,
      posted: [],
      viewState: [],
      reveal() {
        if (!p.visible) {
          p.visible = true;
          p.viewState.forEach((f) => f()); // fires synchronously: the worst case
        }
      },
      hide() {
        p.visible = false;
        p.viewState.forEach((f) => f());
      },
    };
    fake.panel = p;
    return {
      get visible() {
        return p.visible;
      },
      active: true,
      reveal: () => p.reveal(),
      onDidChangeViewState: (f: () => void) => {
        p.viewState.push(f);
        return { dispose() {} };
      },
      onDidDispose: () => ({ dispose() {} }),
      webview: {
        cspSource: "vscode-resource:",
        html: "",
        asWebviewUri: (u: unknown) => ({ toString: () => String(u) }),
        postMessage: (m: unknown) => {
          p.posted.push(m);
          return Promise.resolve(true);
        },
        onDidReceiveMessage: (f: (msg: unknown) => void) => {
          p.message = f;
          return { dispose() {} };
        },
      },
    };
  };
  return {
    window: { createWebviewPanel },
    ViewColumn: { Active: -1 },
    Uri: { joinPath: (...parts: unknown[]) => parts.map(String).join("/") },
    commands: { executeCommand: () => Promise.resolve() },
    env: { openExternal: () => Promise.resolve(true) },
  };
});

import { CostDetailPanel } from "../../src/costPanel/panel";
import type { CostPanelState } from "../../src/costPanel/protocol";

let calls = 0;
const getState = () => {
  calls += 1;
  return { n: calls } as unknown as CostPanelState;
};

function open(): FakePanel {
  CostDetailPanel.current = undefined;
  CostDetailPanel.show({} as never, "session", getState);
  const p = fake.panel!;
  p.message!({ type: "ready" });
  return p;
}

describe("CostDetailPanel live refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    calls = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-showing a dirty panel pushes exactly once", () => {
    const p = open();
    p.posted.length = 0;
    p.hide();
    CostDetailPanel.refresh(); // hidden → marked dirty, nothing posted
    expect(p.posted).toHaveLength(0);
    CostDetailPanel.show({} as never, "session", getState);
    expect(p.posted).toHaveLength(1);
    vi.advanceTimersByTime(5000);
    expect(p.posted).toHaveLength(1);
  });

  it("re-showing cancels a pending throttled refresh", () => {
    const p = open();
    CostDetailPanel.refresh(); // first live refresh pushes now
    CostDetailPanel.refresh(); // within 1s → trailing refresh scheduled
    p.posted.length = 0;
    CostDetailPanel.show({} as never, "session", getState);
    expect(p.posted).toHaveLength(1);
    vi.advanceTimersByTime(5000);
    expect(p.posted).toHaveLength(1); // the scheduled trailing push was cancelled
  });

  it("throttles live refreshes to one per second, keeping the trailing one", () => {
    const p = open();
    p.posted.length = 0;
    for (let k = 0; k < 10; k++) CostDetailPanel.refresh();
    expect(p.posted).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(p.posted).toHaveLength(2);
  });

  it("revealing after a hidden refresh pushes once via the view-state change", () => {
    const p = open();
    p.posted.length = 0;
    p.hide();
    CostDetailPanel.refresh();
    p.reveal();
    expect(p.posted).toHaveLength(1);
  });
});
