import { describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import {
  makeNonce,
  webviewCsp,
  webviewShellHtml,
  isSafeHttpUrl,
  bustCache,
} from "../../src/webviewHost";
import { isSafeHttpUrl as linksIsSafeHttpUrl } from "../../src/links";
import { SCENE_CSS, SCENE_BODY } from "../../src/visualizer/chrome";

// webviewCsp only reads `cspSource`, so a one-field stand-in is a full fake.
const fakeWebview = { cspSource: "vscode-webview://abc123" } as vscode.Webview;

describe("makeNonce", () => {
  it("returns 32 lowercase hex chars (128 bits)", () => {
    const nonce = makeNonce();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is unique per call", () => {
    const seen = new Set(Array.from({ length: 50 }, () => makeNonce()));
    expect(seen.size).toBe(50);
  });
});

describe("bustCache", () => {
  const uri = "vscode-webview://abc123/media/costPanel.js";

  it("appends the revision as a query so a reload re-fetches the bundle", () => {
    expect(bustCache(uri, 1)).toBe(`${uri}?v=1`);
  });

  it("changes with the revision so successive refreshes are distinct urls", () => {
    expect(bustCache(uri, 2)).not.toBe(bustCache(uri, 3));
  });
});

describe("webviewCsp", () => {
  const nonce = makeNonce();
  const csp = webviewCsp(fakeWebview, nonce);

  it("denies by default and scopes scripts to the nonce", () => {
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`script-src 'nonce-${nonce}'`);
  });

  it("never allows eval or remote script", () => {
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("unsafe-inline");
    // script-src must not include the webview origin — only the nonce.
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
    expect(scriptSrc).toBe(`script-src 'nonce-${nonce}'`);
  });

  it("restricts styles/images/fonts to the webview origin and blocks network", () => {
    expect(csp).toContain(`img-src ${fakeWebview.cspSource} data:`);
    expect(csp).toContain(`style-src ${fakeWebview.cspSource} 'nonce-${nonce}'`);
    expect(csp).toContain(`font-src ${fakeWebview.cspSource}`);
    expect(csp).toContain("connect-src 'none'");
  });
});

describe("webviewShellHtml", () => {
  const nonce = "a".repeat(32);
  const base = {
    csp: webviewCsp(fakeWebview, nonce),
    nonce,
    scriptUri: "vscode-webview://abc123/media/costPanel.js",
    title: "Cost Report",
  };

  it("embeds the CSP meta, nonce'd script tag, and script uri", () => {
    const html = webviewShellHtml(base);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${base.csp}" />`);
    expect(html).toContain(`<script nonce="${nonce}" src="${base.scriptUri}"></script>`);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("escapes html-significant characters in title and script uri", () => {
    const html = webviewShellHtml({
      ...base,
      title: `<Cost & "Report">`,
      scriptUri: `vscode-webview://x/a.js?x="1"&y=<z>`,
    });
    expect(html).toContain("<title>&lt;Cost &amp; &quot;Report&quot;&gt;</title>");
    expect(html).toContain(`src="vscode-webview://x/a.js?x=&quot;1&quot;&amp;y=&lt;z&gt;"`);
    expect(html).not.toContain(`<Cost`);
  });

  it("includes headHtml and bodyHtml verbatim when provided", () => {
    const html = webviewShellHtml({
      ...base,
      headHtml: `<style nonce="${nonce}">body{margin:0}</style>`,
      bodyHtml: `<div id="app"></div>`,
    });
    expect(html).toContain(`<style nonce="${nonce}">body{margin:0}</style>`);
    // Body chrome renders before the bundle script.
    expect(html.indexOf(`<div id="app"></div>`)).toBeLessThan(html.indexOf("<script"));
  });

  it("omits them cleanly when not provided", () => {
    const html = webviewShellHtml(base);
    expect(html).not.toContain("<style");
    expect(html).toContain("<body>");
  });
});

// VisualizerPanel.getHtml needs a live WebviewPanel (asWebviewUri), which the
// unit-test vscode stub doesn't provide — so pin the visualizer's document by
// composing the shell exactly as visualizerPanel.ts does.
describe("visualizer document composition", () => {
  it("keeps the nonce'd scene style, body chrome, and CSP intact", () => {
    const nonce = makeNonce();
    const scriptUri = "vscode-webview://abc123/media/visualizer.js";
    const html = webviewShellHtml({
      csp: webviewCsp(fakeWebview, nonce),
      nonce,
      scriptUri,
      title: "AI Orchestration Theater",
      headHtml: `<style nonce="${nonce}">${SCENE_CSS}</style>`,
      bodyHtml: SCENE_BODY,
    });
    expect(html).toContain(`content="default-src 'none'; `);
    expect(html).toContain(`script-src 'nonce-${nonce}'`);
    expect(html).toContain(`<style nonce="${nonce}">${SCENE_CSS}</style>`);
    expect(html).toContain(SCENE_BODY);
    expect(html).toContain(`<script nonce="${nonce}" src="${scriptUri}"></script>`);
  });
});

describe("isSafeHttpUrl (re-export)", () => {
  it("is the canonical checker from links.ts", () => {
    expect(isSafeHttpUrl).toBe(linksIsSafeHttpUrl);
  });

  it("gates open_external targets to absolute http(s)", () => {
    expect(isSafeHttpUrl("https://github.com/promptconduit/cli/pull/1")).toBe(true);
    expect(isSafeHttpUrl("http://localhost:8787")).toBe(true);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeHttpUrl("vscode://extension")).toBe(false);
  });
});
