// Bundles the browser-side webview clients into single nonce-loadable IIFEs
// under media/: the three.js scene (webview/main.ts → media/visualizer.js),
// the cost breakdown report client (webview/costPanel/main.ts →
// media/costPanel.js), the stream client (webview/streamPanel/main.ts →
// media/streamPanel.js), and the session graph client (webview/graphPanel/
// main.ts → media/graphPanel.js). Kept separate from `tsc` (which only emits the
// Node/CommonJS extension into out/) — esbuild tree-shakes three and its addons
// so only what we import ships, and `node_modules` is never packaged into the
// vsix, preserving the extension's zero-runtime-deps property.
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  // Object form pins each output name: media/<key>.js regardless of input path.
  entryPoints: {
    visualizer: "webview/main.ts",
    costPanel: "webview/costPanel/main.ts",
    streamPanel: "webview/streamPanel/main.ts",
    graphPanel: "webview/graphPanel/main.ts",
  },
  bundle: true,
  format: "iife", // one file, one <script nonce> per panel — simplest CSP
  target: ["es2020"], // matches engines.vscode ^1.85 (Electron/Chromium)
  minify: !watch,
  sourcemap: true,
  outdir: "media",
  legalComments: "none",
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[build-webview] watching webview/ …");
} else {
  await esbuild.build(options);
}
