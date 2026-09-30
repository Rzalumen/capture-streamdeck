// Generates com.rezabehjat.capture.sdPlugin/manifest.json from
//   manifest.base.json (plugin metadata + the generic actions),
//   src/catalog/commands.json (one action per Capture command),
//   src/lib/properties.ts (one "Dial: …" action per number property, one "Toggle: …" per boolean).
// Run:  npm run gen   (pack and test run it first). manifest.json is committed; test/manifest.test.ts checks it is up to date.
import fs from "node:fs";
import { buildManifest } from "../src/catalog/manifest.ts";

const dir = "com.rezabehjat.capture.sdPlugin";
const base = JSON.parse(fs.readFileSync("manifest.base.json", "utf8"));
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const manifest = buildManifest(base, pkg.version);
fs.writeFileSync(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
const n = (p) => manifest.Actions.filter((a) => a.UUID.startsWith(`com.rezabehjat.capture.${p}.`)).length;
console.log(`wrote manifest.json: ${manifest.Actions.length} actions (${n("cmd")} commands, ${n("dial")} dials, ${n("toggle")} toggles), v${manifest.Version}`);
