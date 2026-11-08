import { describe, expect, it } from "vitest";
import {
  INIT_COMMAND,
  INSTALL_COMMAND,
  setupState,
  setupStatusBar,
  setupStep,
} from "../../src/setup";
import { locateBinary } from "../../src/binary";
import { buildLoopPanelState } from "../../src/loopPanel/viewModel";
import { renderApp } from "../../webview/loopPanel/render";
import { ConversationStore } from "../../src/state";

describe("setupStep", () => {
  it("asks for the CLI when it is missing and nothing was recorded", () => {
    expect(setupStep({ cliFound: false, eventLogExists: false, logDisabled: false })).toBe("install-cli");
  });

  it("asks for init when the CLI exists but has recorded nothing", () => {
    expect(setupStep({ cliFound: true, eventLogExists: false, logDisabled: false })).toBe("run-init");
  });

  it("is ready whenever the event log exists, even if the binary wasn't found", () => {
    expect(setupStep({ cliFound: false, eventLogExists: true, logDisabled: false })).toBe("ready");
    expect(setupStep({ cliFound: true, eventLogExists: true, logDisabled: false })).toBe("ready");
  });

  it("doesn't nag a user who turned the local log off on purpose", () => {
    expect(setupStep({ cliFound: true, eventLogExists: false, logDisabled: true })).toBe("ready");
  });
});

describe("install guidance", () => {
  it("uses the curl installer, never Homebrew", () => {
    expect(INSTALL_COMMAND).toBe("curl -fsSL https://promptconduit.dev/install | bash");
    expect(INIT_COMMAND).toBe("promptconduit init");
    const all = JSON.stringify([
      setupState("install-cli", "darwin"),
      setupStatusBar("install-cli"),
      setupStatusBar("run-init"),
    ]);
    expect(all).not.toMatch(/brew/i);
  });

  it("drops the bash installer on Windows but keeps the docs link", () => {
    const s = setupState("install-cli", "win32")!;
    expect(s.installCommand).toBeUndefined();
    expect(s.docsUrl).toContain("https://promptconduit.dev/docs/installation");
  });

  it("has no card or status bar override once ready", () => {
    expect(setupState("ready", "darwin")).toBeUndefined();
    expect(setupStatusBar("ready")).toBeUndefined();
  });
});

describe("locateBinary", () => {
  const has = (...paths: string[]) => (p: string) => paths.includes(p);

  it("finds the CLI on PATH", () => {
    expect(
      locateBinary("", { pathEnv: "/usr/bin:/home/me/bin", platform: "linux", exists: has("/home/me/bin/promptconduit") }),
    ).toBe("/home/me/bin/promptconduit");
  });

  it("falls back to the installer's default location", () => {
    expect(locateBinary("", { pathEnv: "/usr/bin", platform: "darwin", exists: has("/usr/local/bin/promptconduit") })).toBe(
      "/usr/local/bin/promptconduit",
    );
  });

  it("returns null (not a bare name) when the CLI is nowhere", () => {
    expect(locateBinary("", { pathEnv: "/usr/bin:/bin", platform: "darwin", exists: has() })).toBeNull();
  });

  it("honors a configured path, and reports it missing", () => {
    expect(locateBinary("/opt/pc", { exists: has("/opt/pc") })).toBe("/opt/pc");
    expect(locateBinary("/opt/pc", { pathEnv: "/usr/local/bin", exists: has("/usr/local/bin/promptconduit") })).toBeNull();
  });

  it("looks for promptconduit.exe on Windows", () => {
    expect(
      locateBinary("", {
        pathEnv: "C:\\Windows;C:\\Tools",
        platform: "win32",
        exists: has("C:\\Tools\\promptconduit.exe"),
      }),
    ).toBe("C:\\Tools\\promptconduit.exe");
  });
});

describe("The Loop setup card", () => {
  const empty = () => buildLoopPanelState(new ConversationStore(), { followLatest: true });

  it("shows install + init steps in the zero state when the CLI is missing", () => {
    const state = { ...empty(), setup: setupState("install-cli", "darwin") };
    const html = renderApp(state);
    expect(html).toContain("Set up cost tracking");
    expect(html).toContain("curl -fsSL https://promptconduit.dev/install | bash");
    expect(html).toContain('data-cmd="installCli"');
    expect(html).toContain('data-cmd="runInit"');
    expect(html).toContain("promptconduit init");
    expect(html).not.toMatch(/brew/i);
  });

  it("shows only the init step when the CLI is installed", () => {
    const html = renderApp({ ...empty(), setup: setupState("run-init", "darwin") });
    expect(html).toContain('data-cmd="runInit"');
    expect(html).not.toContain('data-cmd="installCli"');
    expect(html).not.toContain("curl -fsSL");
  });

  it("keeps the generic zero state once setup is done", () => {
    const html = renderApp(empty());
    expect(html).not.toContain("Set up cost tracking");
    expect(html).toContain("Run a prompt in Claude Code or Cursor");
  });
});
