// Adds an exported Stream Deck+ profile to the plugin as its default profile, replacing the generated one.
//   npm run add-profile -- ~/Desktop/Capture.streamDeckProfile
// Copies the file to com.rezabehjat.capture.sdPlugin/profiles/Capture.streamDeckProfile (declared in manifest.base.json
// "Profiles": Name "profiles/Capture", DeviceType 7 = Stream Deck +) and leaves a profiles/CUSTOM marker so that
// `npm run gen-profile` and the tests know this file is yours and do not overwrite / compare it.
// To go back to the generated profile:  npm run gen-profile -- --force
import fs from "node:fs";
import path from "node:path";

const src = process.argv[2];
if (!src || !src.endsWith(".streamDeckProfile") || !fs.existsSync(src)) {
  console.error("usage: npm run add-profile -- <exported file>.streamDeckProfile");
  process.exit(1);
}
const dir = path.join("com.rezabehjat.capture.sdPlugin", "profiles");
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(src, path.join(dir, "Capture.streamDeckProfile"));
fs.writeFileSync(path.join(dir, "CUSTOM"), "This profile was added with `npm run add-profile`; gen-profile will not overwrite it without --force.\n");
console.log("profile added; run `npm run pack` to rebuild the .streamDeckPlugin");
