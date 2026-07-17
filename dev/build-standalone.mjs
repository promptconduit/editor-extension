// Builds the "generic website" proof: bundles the Session Graph's PORTABLE core
// (webview/graphPanel/standalone.ts → mount + render + connectors + styles +
// sessionTree) into ONE self-contained HTML file with the JS inlined and no
// external requests, no vscode. Open it in any browser.
//
//   node dev/build-standalone.mjs        # → dev/preview-out/graph-standalone.html
//
// This is a dev artifact only — it is NOT part of `npm run compile` and never
// ships in the vsix (build-webview.mjs, which populates media/, doesn't include it).
import esbuild from "esbuild";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const outDir = fileURLToPath(new URL("./preview-out/", import.meta.url));
fs.mkdirSync(outDir, { recursive: true });

const result = await esbuild.build({
  entryPoints: [fileURLToPath(new URL("../webview/graphPanel/standalone.ts", import.meta.url))],
  bundle: true,
  format: "iife",
  target: ["es2020"],
  minify: true,
  write: false,
  logLevel: "info",
});

const js = result.outputFiles[0].text;
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PromptConduit — Session Graph (standalone)</title>
<!-- No --vscode-* variables defined: the panel's CSS fallbacks theme it on a
     plain page. A host site could define them (or its own palette) to reskin. -->
<style>body{margin:0;background:#1e1e1e;color:#ccc;font-family:-apple-system,"Segoe UI",sans-serif;padding:0 1.5rem;}</style>
</head>
<body>
<script>${js}</script>
</body>
</html>`;

const outFile = outDir + "graph-standalone.html";
fs.writeFileSync(outFile, html);
console.log(`Wrote self-contained ${(html.length / 1024).toFixed(1)}kb → ${outFile}`);
