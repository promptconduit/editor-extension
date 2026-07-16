// Builds the CLI graph viewer's page: bundles the PORTABLE graph core
// (webview/graphPanel/cliClient.ts → mount + render + connectors + styles +
// sessionTree) into ONE self-contained graph.html with the JS inlined and no
// external requests. The `promptconduit graph` command embeds this file via
// go:embed and serves it; the page polls the CLI's /api/events endpoint.
//
//   node dev/build-cli-bundle.mjs --out <path>   # default: dist/graph.html
//
// The CLI's `make refresh-graph` target runs this with --out pointed straight at
// cli/internal/graph/ui/graph.html. Deterministic output (esbuild), so the CLI's
// refresh workflow can byte-diff it. Not part of `npm run compile`; never ships
// in the vsix.
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
  : fileURLToPath(new URL("./preview-out/graph.html", import.meta.url));

const result = await esbuild.build({
  entryPoints: [fileURLToPath(new URL("../webview/graphPanel/cliClient.ts", import.meta.url))],
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
<title>PromptConduit — Session Graph</title>
<!-- Rendered by the portable graph core (shared with the editor extension).
     No --vscode-* variables defined: the panel CSS falls back to literals. -->
<style>body{margin:0;background:#1e1e1e;color:#ccc;font-family:-apple-system,"Segoe UI",sans-serif;padding:0 1.5rem;}</style>
</head>
<body>
<script>${js}</script>
</body>
</html>`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`Wrote self-contained ${(html.length / 1024).toFixed(1)}kb → ${outFile}`);
