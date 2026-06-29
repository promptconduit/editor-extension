// Bundles the browser-side three.js scene (webview/main.ts) into a single
// nonce-loadable IIFE at media/visualizer.js. Kept separate from `tsc` (which
// only emits the Node/CommonJS extension into out/) — esbuild tree-shakes three
// and its addons so only what we import ships, and `node_modules` is never
// packaged into the vsix, preserving the extension's zero-runtime-deps property.
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["webview/main.ts"],
  bundle: true,
  format: "iife", // one file, one <script nonce> — simplest CSP
  target: ["es2020"], // matches engines.vscode ^1.85 (Electron/Chromium)
  minify: !watch,
  sourcemap: true,
  outfile: "media/visualizer.js",
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
