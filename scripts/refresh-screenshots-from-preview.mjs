#!/usr/bin/env node
/**
 * Regenerate committed README / Open VSX screenshots from dev/preview-out/.
 * Run after `npm run compile && PREVIEW_NO_OPEN=1 npm run preview`.
 */
import { chromium } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(fileURLToPath(import.meta.url), "..", "..");
const previewDir = path.join(root, "dev", "preview-out");
const outDir = path.join(root, "resources", "screenshots");

const shots = [
  { html: "breakdown-detail.html", slug: "cost-breakdown", waitMs: 500 },
  { html: "graph.html", slug: "graph", waitMs: 800 },
  { html: "stream.html", slug: "stream", waitMs: 500 },
  { html: "coaching-rich.html", slug: "agent-coaching", waitMs: 500 },
  { html: "visualizer.html", slug: "orchestration-theater", waitMs: 3500 },
];

if (!fs.existsSync(previewDir)) {
  console.error("Missing dev/preview-out — run: PREVIEW_NO_OPEN=1 npm run preview");
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

for (const { html, slug, waitMs } of shots) {
  const file = path.join(previewDir, html);
  if (!fs.existsSync(file)) {
    console.warn(`skip ${html} (not found)`);
    continue;
  }
  await page.goto(`file://${file}`);
  await page.waitForTimeout(waitMs);
  const panel = path.join(outDir, `${slug}-panel.png`);
  const window = path.join(outDir, `${slug}-window.png`);
  await page.locator("body").screenshot({ path: panel });
  fs.copyFileSync(panel, window);
  console.log(`✔ ${slug}-window.png`);
}

await browser.close();
