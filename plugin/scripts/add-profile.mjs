// Adds an exported Stream Deck+ profile to the plugin as its default profile.
//   npm run add-profile -- ~/Desktop/Capture.streamDeckProfile
// Copies the file to com.rezabehjat.capture.sdPlugin/profiles/Capture.streamDeckProfile and registers it in
// manifest.json ("Profiles": Name "profiles/Capture", DeviceType 7 = Stream Deck +).
import fs from "node:fs";
import path from "node:path";

const src = process.argv[2];
if (!src || !src.endsWith(".streamDeckProfile") || !fs.existsSync(src)) {
  console.error("usage: npm run add-profile -- <exported file>.streamDeckProfile");
  process.exit(1);
}
const dir = "com.rezabehjat.capture.sdPlugin";
fs.mkdirSync(path.join(dir, "profiles"), { recursive: true });
fs.copyFileSync(src, path.join(dir, "profiles/Capture.streamDeckProfile"));

const mp = path.join(dir, "manifest.json");
const m = JSON.parse(fs.readFileSync(mp, "utf8"));
m.Profiles = [{ Name: "profiles/Capture", DeviceType: 7, Readonly: false, DontAutoSwitchWhenInstalled: false }];
fs.writeFileSync(mp, JSON.stringify(m, null, 2) + "\n");
console.log("profile added; run `npm run pack` to rebuild the .streamDeckPlugin");
