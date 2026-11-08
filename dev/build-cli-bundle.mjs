// Builds the page the CLI serves for `promptconduit loop`: bundles The Loop's
// webview client plus a browser shim (webview/loopPanel/cliClient.ts) into ONE
// self-contained loop.html with the JS inlined and no external requests. The
// CLI embeds this file via go:embed and serves it; the page polls the CLI's
// local /api/events endpoint and builds everything in the browser with the
// same store, view model and renderer as the editor panel.
//
//   node dev/build-cli-bundle.mjs --out <path>   # default: dev/preview-out/loop.html
//
// The CLI's refresh target runs this with --out pointed at its embedded ui/
// directory. Deterministic output (esbuild), so the CLI can byte-diff it. Not
// part of `npm run compile`; never ships in the vsix.
import esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const argOut = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();
const outFile = argOut
  ? path.resolve(argOut)
  : fileURLToPath(new URL("./preview-out/cli-loop.html", import.meta.url));

const result = await esbuild.build({
  entryPoints: [fileURLToPath(new URL("../webview/loopPanel/cliClient.ts", import.meta.url))],
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
<title>The Loop · PromptConduit</title>
</head>
<body>
<div id="app"></div>
<script>${js}</script>
</body>
</html>`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`Wrote self-contained ${(html.length / 1024).toFixed(1)}kb → ${outFile}`);
