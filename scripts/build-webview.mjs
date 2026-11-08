// Bundles the browser-side webview client into one nonce-loadable IIFE under
// media/: The Loop (webview/loopPanel/main.ts → media/loopPanel.js). Kept
// separate from `tsc`, which only emits the Node/CommonJS extension into out/.
// node_modules is never packaged into the vsix, so the extension keeps zero
// runtime dependencies.
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  // Object form pins each output name: media/<key>.js regardless of input path.
  entryPoints: {
    loopPanel: "webview/loopPanel/main.ts",
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
