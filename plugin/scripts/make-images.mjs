// Generates the static PNG artwork in com.rezabehjat.capture.sdPlugin/imgs from the plugin's own SVG icons.
// Dev tool only (needs Playwright + Chromium):  npm i -g playwright && npm run images
// Run through tsx so the TypeScript icon table can be imported:  node --import tsx scripts/make-images.mjs
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ICONS } from "../src/lib/icons.ts";
import { COLORS } from "../src/lib/render.ts";

const require = createRequire(import.meta.url);
const globalRoot = execSync("npm root -g").toString().trim();
const { chromium } = require(require.resolve("playwright", { paths: [globalRoot, process.cwd()] }));

const OUT = "com.rezabehjat.capture.sdPlugin/imgs";
const glyph = (name, color, stroke = 1.6) =>
  `<g fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</g>`;

/** @returns SVG for size×size with the icon centred, scaled to `frac` of the size. */
function svg(size, name, { color, bg, frac = 0.7, radius = 0, stroke = 1.6 }) {
  const s = size * frac;
  const o = (size - s) / 2;
  const back = bg ? `<rect width="${size}" height="${size}" rx="${radius}" fill="${bg}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${back}<g transform="translate(${o} ${o}) scale(${s / 24})">${glyph(name, color, stroke)}</g></svg>`;
}

const jobs = [];
const add = (file, size, name, opts) => jobs.push({ file: path.join(OUT, file), size, svg: svg(size, name, opts) });

const actions = { command: "command", tab: "tabs", slot: "camera", store: "store", position: "position", dial: "exposure", toggle: "autoexposure", connection: "connection" };
for (const [a, icon] of Object.entries(actions)) {
  for (const [suffix, k] of [["", 1], ["@2x", 2]]) {
    add(`actions/${a}/icon${suffix}.png`, 20 * k, icon, { color: "#FFFFFF", frac: 0.9, stroke: 1.8 });
    add(`actions/${a}/key${suffix}.png`, 72 * k, icon, { color: COLORS.accent, bg: COLORS.bg, frac: 0.55 });
  }
}
for (const [suffix, k] of [["", 1], ["@2x", 2]]) {
  add(`plugin/category-icon${suffix}.png`, 28 * k, "plugin", { color: "#FFFFFF", frac: 0.9, stroke: 1.8 });
  add(`plugin/marketplace${suffix}.png`, 256 * k, "plugin", { color: COLORS.accent, bg: COLORS.bg, frac: 0.62, radius: 56 * k, stroke: 1.3 });
}

const browser = await chromium.launch();
const page = await browser.newPage();
for (const j of jobs) {
  fs.mkdirSync(path.dirname(j.file), { recursive: true });
  await page.setViewportSize({ width: j.size, height: j.size });
  await page.setContent(`<body style="margin:0;background:transparent">${j.svg}</body>`);
  await page.screenshot({ path: j.file, omitBackground: true, clip: { x: 0, y: 0, width: j.size, height: j.size } });
}
await browser.close();
console.log(`wrote ${jobs.length} images under ${OUT}`);
