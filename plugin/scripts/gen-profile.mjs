// Generates the default Stream Deck+ profile ("Capture": HOME → category folders → command keys and dials) and writes it to
//   com.rezabehjat.capture.sdPlugin/profiles/Capture.streamDeckProfile   (declared in manifest.base.json "Profiles")
//
//   npm run gen-profile                          write the bundled profile
//   npm run gen-profile -- --out ~/Desktop/Capture.streamDeckProfile     also / only write a standalone copy
//   CAPTURE_APP_PATH="/Applications/Capture 2025.app" npm run gen-profile   other Capture version (auto-switch target)
//
// Needs profile-art/ (run `npm run images -- --profile` if an icon is missing). Deterministic: same inputs, same bytes.
// Refuses to replace a profile you added yourself with `npm run add-profile` (profiles/CUSTOM marker) unless --force.
import fs from "node:fs";
import path from "node:path";
import { buildManifest } from "../src/catalog/manifest.ts";
import { buildLayout } from "../src/profile/layout.ts";
import { buildProfileZip, DEFAULT_CAPTURE_APP } from "../src/profile/build.ts";
import { checkProfile } from "../src/profile/check.ts";
import { readZip } from "../src/profile/zip.ts";

const sd = "com.rezabehjat.capture.sdPlugin";
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const outIdx = args.indexOf("--out");
const extra = outIdx >= 0 ? args[outIdx + 1] : undefined;
if (outIdx >= 0 && !extra) throw new Error("--out needs a path");

const base = JSON.parse(fs.readFileSync("manifest.base.json", "utf8"));
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const manifest = buildManifest(base, pkg.version);
const layout = buildLayout();

const image = (style, icon) => {
  const f = path.join("profile-art", style, `${icon}.png`);
  if (!fs.existsSync(f)) throw new Error(`missing ${f} — run: npm run images -- --profile`);
  return fs.readFileSync(f);
};
const appPath = process.env.CAPTURE_APP_PATH || DEFAULT_CAPTURE_APP;
const zip = buildProfileZip(layout, { manifest, image, appPath });

const problems = checkProfile(readZip(zip), manifest);
if (problems.length) {
  console.error(`the generated profile is invalid (${problems.length}):\n  ${problems.slice(0, 20).join("\n  ")}`);
  process.exit(1);
}

const bundled = path.join(sd, "profiles", "Capture.streamDeckProfile");
const custom = path.join(sd, "profiles", "CUSTOM");
if (!extra || flag("--bundle")) {
  if (fs.existsSync(custom) && !flag("--force")) {
    console.error(`${bundled} was added with \`npm run add-profile\` (marker ${custom}); not replacing it. Use --force to regenerate, or delete the marker.`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.writeFileSync(bundled, zip);
  if (fs.existsSync(custom)) fs.rmSync(custom);
  console.log(`wrote ${bundled} (${zip.length} bytes)`);
}
if (extra) {
  fs.mkdirSync(path.dirname(path.resolve(extra)), { recursive: true });
  fs.writeFileSync(extra, zip);
  console.log(`wrote ${extra} (${zip.length} bytes)`);
}
const keys = layout.pages.reduce((n, p) => n + p.keys.size, 0);
console.log(`${layout.pages.length} pages, ${keys} keys, AppIdentifier ${appPath}`);
