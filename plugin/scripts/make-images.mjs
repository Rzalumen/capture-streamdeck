// Generates the static PNG artwork in com.rezabehjat.capture.sdPlugin/imgs from the plugin's own SVG icons.
// Also writes the 144×144 key art for the generated default profile into profile-art/ (not shipped inside the plugin).
// Dev tool only (needs Playwright + Chromium):  npm i -g playwright && npm run images
//   npm run images                 every image (plugin + profile art)
//   npm run images -- --profile    only profile-art/ (what `npm run gen-profile` reads)
// Run through tsx so the TypeScript icon table can be imported:  node --import tsx scripts/make-images.mjs
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ICONS } from "../src/lib/icons.ts";
import { COLORS } from "../src/lib/render.ts";
import { buildLayout, iconsUsed } from "../src/profile/layout.ts";

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

const onlyProfile = process.argv.includes("--profile");
const PROFILE_ART = "profile-art";
const jobs = [];
const add = (file, size, name, opts) => {
  if (!onlyProfile) jobs.push({ file: path.join(OUT, file), size, svg: svg(size, name, opts) });
};

const actions = { command: "command", tab: "tabs", slot: "camera", store: "store", position: "position", dial: "exposure", toggle: "autoexposure", connection: "connection" };
for (const [a, icon] of Object.entries(actions)) {
  for (const [suffix, k] of [["", 1], ["@2x", 2]]) {
    add(`actions/${a}/icon${suffix}.png`, 20 * k, icon, { color: "#FFFFFF", frac: 0.9, stroke: 1.8 });
    add(`actions/${a}/key${suffix}.png`, 72 * k, icon, { color: COLORS.accent, bg: COLORS.bg, frac: 0.55 });
  }
}
// One action-list icon (20 px) and one key image (72 px) per glyph used by the generated actions (imgs/icons, imgs/keys).
const manifest = JSON.parse(fs.readFileSync("com.rezabehjat.capture.sdPlugin/manifest.json", "utf8"));
const used = new Set(manifest.Actions.map((a) => a.Icon).filter((i) => i.startsWith("imgs/icons/")).map((i) => i.slice("imgs/icons/".length)));
for (const n of Object.keys(ICONS)) if (n.startsWith("cat-")) used.add(n);
for (const name of used) {
  if (!ICONS[name]) throw new Error(`manifest uses icon "${name}" which is not in src/lib/icons.ts`);
  for (const [suffix, k] of [["", 1], ["@2x", 2]]) {
    add(`icons/${name}${suffix}.png`, 20 * k, name, { color: "#FFFFFF", frac: 0.9, stroke: 1.8 });
    add(`keys/${name}${suffix}.png`, 72 * k, name, { color: COLORS.accent, bg: COLORS.bg, frac: 0.55 });
  }
}
for (const [suffix, k] of [["", 1], ["@2x", 2]]) {
  add(`plugin/category-icon${suffix}.png`, 28 * k, "plugin", { color: "#FFFFFF", frac: 0.9, stroke: 1.8 });
  add(`plugin/marketplace${suffix}.png`, 256 * k, "plugin", { color: COLORS.accent, bg: COLORS.bg, frac: 0.62, radius: 56 * k, stroke: 1.3 });
}

// Key art for the generated profile: 144×144, dark background baked in, original glyphs only.
//   key/<icon>.png     glyph centred (keys whose label the plugin draws itself, and dials)
//   folder/<icon>.png  glyph raised to leave room for the title Stream Deck draws on folder / Back / More keys
{
  const used = iconsUsed(buildLayout());
  for (const name of used.keys) {
    if (!ICONS[name]) throw new Error(`profile uses icon "${name}" which is not in src/lib/icons.ts`);
    jobs.push({ file: path.join(PROFILE_ART, "key", `${name}.png`), size: 144, svg: svg(144, name, { color: COLORS.accent, bg: COLORS.bg, frac: 0.55 }) });
  }
  for (const name of used.folders) {
    if (!ICONS[name]) throw new Error(`profile uses icon "${name}" which is not in src/lib/icons.ts`);
    const s = 144 * 0.5;
    const o = (144 - s) / 2;
    jobs.push({
      file: path.join(PROFILE_ART, "folder", `${name}.png`),
      size: 144,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="${COLORS.bg}"/><g transform="translate(${o} ${o - 12}) scale(${s / 24})">${glyph(name, COLORS.accent, 1.7)}</g></svg>`,
    });
  }
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
console.log(`wrote ${jobs.length} images`);
