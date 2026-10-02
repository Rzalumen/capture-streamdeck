/**
 * The generated default profile (Handoff 09): layout rules, zip structure, and the checker that guards both.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ENTRIES, actionName, uuidOf } from "../src/catalog/index.ts";
import { buildManifest, type Manifest } from "../src/catalog/manifest.ts";
import { CONNECTION_UUID, STORE_MODIFIER_UUID, showPositionUuid } from "../src/catalog/extras.ts";
import { BACK_UUID, COMMAND_SLOTS, DIAL_POSITIONS, DIAL_SETS, KEY_POSITIONS_ALL, MORE_SLOT, OPEN_CHILD_UUID, buildLayout, iconsUsed, type Key, type Page } from "../src/profile/layout.ts";
import { DEFAULT_CAPTURE_APP, buildProfileFiles, buildProfileZip, imageId } from "../src/profile/build.ts";
import { checkProfile, pngSize } from "../src/profile/check.ts";
import { crc32, readZip, writeZip, type ZipEntry } from "../src/profile/zip.ts";
import { dialUuid, toggleUuid } from "../src/lib/named.ts";
import { BOOL_PROPERTIES, NUMBER_PROPERTIES } from "../src/lib/properties.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sd = path.join(root, "com.rezabehjat.capture.sdPlugin");
const base = JSON.parse(fs.readFileSync(path.join(root, "manifest.base.json"), "utf8")) as Manifest;
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = buildManifest(base, pkg.version);
const image = (style: "key" | "folder", icon: string): Buffer => fs.readFileSync(path.join(root, "profile-art", style, `${icon}.png`));

const layout = buildLayout();
const files = buildProfileFiles(layout, { manifest, image });
const zip = buildProfileZip(layout, { manifest, image });
const unzipped = readZip(zip);

// ---------------------------------------------------------------- layout
const titleOf = (k: Key | undefined): string => (k ? (k.type === "action" ? k.title : k.title) : "(empty)");
const folderKey = (p: Page, pos: string): Extract<Key, { type: "folder" }> => {
  const k = p.keys.get(pos);
  assert.equal(k?.type, "folder", `${p.path} ${pos}`);
  return k as Extract<Key, { type: "folder" }>;
};
/** All command keys of a folder chain in order (skipping Back, following More ▸). Sub-folders are returned as their key. */
function chain(first: Page): { pages: Page[]; keys: Key[] } {
  const pages: Page[] = [];
  const keys: Key[] = [];
  for (let p: Page | undefined = first; p; ) {
    pages.push(p);
    let next: Page | undefined;
    for (const pos of COMMAND_SLOTS) {
      const k = p.keys.get(pos);
      if (!k) continue;
      if (pos === MORE_SLOT && k.type === "folder" && k.title === "More ▸") next = k.child;
      else keys.push(k);
    }
    p = next;
  }
  return { pages, keys };
}
const folder = (name: string): Page => {
  const pos = KEY_POSITIONS_ALL.find((q) => titleOf(layout.home.keys.get(q)) === name);
  assert.ok(pos, `HOME has a ${name} folder`);
  return folderKey(layout.home, pos).child;
};

/** Look is the last item of the View chain since v0.4 (HOME slot 8 is Fixtures). */
const lookPage = (): Page => {
  const last = chain(folder("View")).keys.at(-1)!;
  assert.equal(titleOf(last), "Look ▸");
  return (last as Extract<Key, { type: "folder" }>).child;
};
const isFixturesPage = (p: Page): boolean => p.path === "fixtures" || p.path.startsWith("fixtures/");

test("HOME: row 0 = View · Camera · Select · Edit, row 1 = Patch & Focus · Windows · File · Fixtures; all folders", () => {
  const order = ["View", "Camera", "Select", "Edit", "Patch & Focus", "Windows", "File", "Fixtures"];
  assert.deepEqual(KEY_POSITIONS_ALL.map((p) => titleOf(layout.home.keys.get(p))), order);
  for (const p of KEY_POSITIONS_ALL) assert.equal(layout.home.keys.get(p)?.type, "folder");
  assert.equal(layout.home.keys.size, 8);
  assert.deepEqual(KEY_POSITIONS_ALL.slice(0, 4), ["0,0", "1,0", "2,0", "3,0"]);
  assert.deepEqual(KEY_POSITIONS_ALL.slice(4), ["0,1", "1,1", "2,1", "3,1"]);
});

test("every child page: Back at 0,0, commands only in 1,0 → 3,0 → 0,1 → 3,1 (7 slots, filled from the front)", () => {
  assert.deepEqual([...COMMAND_SLOTS], ["1,0", "2,0", "3,0", "0,1", "1,1", "2,1", "3,1"]);
  for (const p of layout.pages) {
    if (p === layout.home) continue;
    assert.equal(p.keys.get("0,0")?.type, "back", p.path);
    const used = COMMAND_SLOTS.filter((s) => p.keys.has(s));
    if (isFixturesPage(p)) continue; // the Fixtures pages keep More ▸ in 3,1 with two empty slots before it (see the Fixtures tests)
    assert.deepEqual(used, COMMAND_SLOTS.slice(0, used.length), `${p.path}: slots are filled in order without gaps`);
    assert.equal(p.keys.size, 1 + used.length);
    assert.ok(p.keys.size <= 8);
  }
});

test("more than 7 commands: slot 3,1 becomes 'More ▸' to the next page (which has its own Back); nothing else does", () => {
  for (const p of layout.pages) {
    if (p === layout.home) continue;
    const last = p.keys.get(MORE_SLOT);
    const isMore = last?.type === "folder" && last.title === "More ▸";
    if (isMore) {
      if (!isFixturesPage(p)) assert.equal(p.keys.size, 8, `${p.path}: a page with More is full`);
      assert.equal(last.child.keys.get("0,0")?.type, "back");
      assert.equal(last.child.parent, p, "Back from the next page returns to this one");
      assert.ok(last.child.keys.size >= 2, "the next page is never empty");
    }
    for (const k of p.keys.values()) if (k.type === "folder" && k.title === "More ▸") assert.equal(k, last, "More ▸ only ever sits in 3,1");
  }
  // a folder with exactly 7 commands needs no More (Look has 3, the Camera Positions page has 7)
  assert.equal(lookPage().keys.size, 4);
});

test("View / Select / Edit / Patch & Focus / File hold their catalog category, in catalog order", () => {
  const expect = (name: string, slug: string): void => {
    const got = chain(folder(name)).keys.map((k) => (k.type === "action" ? k.uuid : "?"));
    assert.deepEqual(got, ENTRIES.filter((e) => e.category === slug).map(uuidOf), name);
  };
  {
    // View: its catalog commands, then the Look folder as the last item of the chain
    const keys = chain(folder("View")).keys;
    assert.equal(titleOf(keys.at(-1)), "Look ▸");
    assert.deepEqual(keys.slice(0, -1).map((k) => (k.type === "action" ? k.uuid : "?")), ENTRIES.filter((e) => e.category === "view").map(uuidOf));
  }
  expect("Select", "select");
  expect("Edit", "edit");
  expect("Patch & Focus", "patch");
  expect("File", "file");
  assert.equal(chain(folder("Edit")).pages.length, 4, "Edit chains four pages (25 commands: 6 + 6 + 6 + 7)");
});

test("Windows: Tabs (6) first, then the Navigate and Window categories", () => {
  const got = chain(folder("Windows")).keys.map((k) => (k.type === "action" ? k.uuid : "?"));
  const want = [...ENTRIES.filter((e) => e.category === "tabs"), ...ENTRIES.filter((e) => e.category === "navigate"), ...ENTRIES.filter((e) => e.category === "window")].map(uuidOf);
  assert.deepEqual(got, want);
  assert.equal(want.slice(0, 6).every((u) => u.includes(".cmd.tabs.")), true);
});

test("Camera: Swing/Focus on the first pages; Positions 1–5 + Store Modifier together on ONE page of their own (v0.3.1)", () => {
  const first = folder("Camera");
  const { keys, pages } = chain(first);
  const cam = ENTRIES.filter((e) => e.category === "camera");
  const swing = cam.filter((e) => !/^(position|store)-\d$/.test(e.id)).map(uuidOf);
  const pos = cam.filter((e) => /^position-\d$/.test(e.id)).map(uuidOf);
  const stores = cam.filter((e) => /^store-\d$/.test(e.id)).map(uuidOf);
  assert.equal(swing.length, 7);
  // Camera pages hold only Swing/Focus commands plus the folder that leads to the Positions page
  assert.deepEqual(keys.filter((k) => k.type === "action").map((k) => (k as { uuid: string }).uuid), swing, "all seven Swing/Focus commands, in order, on the Camera pages");
  assert.equal(pages.length, 2);
  const posKey = first.keys.get("2,1");
  assert.equal(posKey?.type, "folder");
  assert.equal(titleOf(posKey), "Positions ▸", "the Positions page is one press away from the first Camera page");
  // The Positions page: Position 1–5 + Store Modifier on the SAME page, plus the Show ▸ folder; no More, no second page.
  const posPage = (posKey as Extract<Key, { type: "folder" }>).child;
  const onPage = COMMAND_SLOTS.map((sl) => posPage.keys.get(sl)).filter((k): k is Key => !!k);
  assert.deepEqual(onPage.slice(0, 6).map((k) => (k.type === "action" ? k.uuid : "?")), [...pos, STORE_MODIFIER_UUID]);
  assert.equal(onPage.length, 7);
  assert.equal(titleOf(onPage[6]), "Show ▸");
  assert.ok(!onPage.some((k) => k.type === "folder" && k.title === "More ▸"), "Positions 1–5 and Store Modifier are not split by a More ▸");
  assert.equal(posPage.keys.get("0,0")?.type, "back");
  // Show ▸: Show Position 1–8 and Store Camera 1–5 (13 keys → 2 pages)
  const inner = chain((onPage[6] as Extract<Key, { type: "folder" }>).child);
  assert.deepEqual(
    inner.keys.map((k) => (k.type === "action" ? k.uuid : "?")),
    [...Array.from({ length: 8 }, (_, i) => showPositionUuid(i + 1)), ...stores],
  );
  assert.equal(inner.pages.length, 2, "13 keys: 6 + More, then 7");
  assert.equal(inner.pages[1].keys.size, 8, "second page: Back + 7 keys, no More");
});

test("Look: Auto Exposure, Laser Flicker, Connection", () => {
  const { keys } = chain(lookPage());
  assert.deepEqual(keys.map((k) => (k.type === "action" ? k.uuid : "?")), [...BOOL_PROPERTIES.map(toggleUuid), CONNECTION_UUID]);
  assert.deepEqual(keys.map((k) => (k.type === "action" ? k.name : "?")), ["Look: Auto Exposure", "Look: Laser Flicker", "Status: Connection"]);
});

test("dials: every page has its own four; standard set everywhere, View set on View pages, Flare set on the Look folder", () => {
  const ids = (p: Page): string[] => DIAL_POSITIONS.map((pos) => p.dials.get(pos)!.property);
  assert.deepEqual([...DIAL_SETS.standard], ["exposureAdjustment", "ambientLighting", "bloom", "whiteBalance"]);
  assert.deepEqual([...DIAL_SETS.view], ["contrast", "saturation", "fillLighting", "hueClamp"]);
  assert.deepEqual([...DIAL_SETS.look], ["flare", "flareStreaks", "flareAngle", "flareSize"]);
  const viewPages = new Set(chain(folder("View")).pages);
  const lookPages = new Set(chain(lookPage()).pages);
  for (const p of layout.pages) {
    if (isFixturesPage(p)) continue; // own dial sets, see the Fixtures tests
    assert.equal(p.dials.size, 4, p.path);
    assert.deepEqual(ids(p), [...(viewPages.has(p) ? DIAL_SETS.view : lookPages.has(p) ? DIAL_SETS.look : DIAL_SETS.standard)], p.path);
  }
  assert.equal(viewPages.size, 3);
  assert.equal(lookPages.size, 1);
  assert.deepEqual(ids(layout.home), [...DIAL_SETS.standard]);
  for (const p of layout.pages) if (!isFixturesPage(p)) for (const d of p.dials.values()) assert.ok(NUMBER_PROPERTIES.some((n) => dialUuid(n) === d.uuid));
});

test("Fixtures folder: four pages; every page has Back · Setup · Release · Home Selected · Status (+ More ▸ except the last) and its own dial set", () => {
  const { pages } = chain(folder("Fixtures"));
  assert.equal(pages.length, 4);
  const U = "com.rezabehjat.capture";
  const keyUuids = ["fixtures.setup", "fixtures.release", "fixtures.home", "fixtures.status"].map((k) => `${U}.${k}`);
  pages.forEach((p, i) => {
    assert.equal(p.keys.get("0,0")?.type, "back", p.path);
    assert.deepEqual(["1,0", "2,0", "3,0", "0,1"].map((pos) => (p.keys.get(pos) as { uuid: string }).uuid), keyUuids, p.path);
    const more = p.keys.get(MORE_SLOT);
    if (i < 3) assert.equal(titleOf(more), "More ▸", p.path);
    else assert.equal(more, undefined, "the last page has no More");
    assert.equal(p.keys.size, i < 3 ? 6 : 5);
    assert.equal(p.parent, i === 0 ? layout.home : pages[i - 1], "Back returns to the page before");
  });
  const dialIds = (p: Page): string[] => DIAL_POSITIONS.filter((pos) => p.dials.has(pos)).map((pos) => (p.dials.get(pos)!.uuid.slice(`${U}.fixture.`.length)));
  assert.deepEqual(dialIds(pages[0]), ["select", "pan", "tilt", "intensity"]);
  assert.deepEqual(dialIds(pages[1]), ["select", "zoom", "focus", "iris"]);
  assert.deepEqual(dialIds(pages[2]), ["select", "red-cyan", "green-magenta", "blue-yellow"]);
  assert.deepEqual(dialIds(pages[3]), ["select", "white"]);
  assert.equal(pages[3].dials.size, 2, "two empty dial slots on the fourth page");
  assert.equal(pages[0].dials.get("0,0")?.title, "Select");
});

test("page UUIDs are unique, and the same on every build", () => {
  assert.equal(new Set(layout.pages.map((p) => p.id)).size, layout.pages.length);
  assert.deepEqual(buildLayout().pages.map((p) => p.id), layout.pages.map((p) => p.id));
  for (const p of layout.pages) assert.match(p.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

// ---------------------------------------------------------------- the zip
const ROOT_RE = /^Profiles\/([0-9A-F-]{36})\.sdProfile\/$/;
const rootDir = [...unzipped.keys()].find((n) => ROOT_RE.test(n))!;
const pageManifests = (): Map<string, { Controllers: { Type: string; Actions: Record<string, any> }[] }> => {
  const m = new Map();
  for (const [n, d] of unzipped) {
    const r = new RegExp(`^${rootDir.replace(/[.]/g, "\\.")}Profiles/([0-9A-F-]{36})/manifest\\.json$`).exec(n);
    if (r && d) m.set(r[1], JSON.parse(d.toString("utf8")));
  }
  return m;
};

test("the checker finds nothing wrong with the generated profile", () => {
  assert.deepEqual(checkProfile(unzipped, manifest), []);
});

test("zip structure matches the reference layout exactly", () => {
  const names = [...unzipped.keys()];
  assert.equal(names[0], "package.json");
  assert.deepEqual(JSON.parse(unzipped.get("package.json")!.toString()), {
    AppVersion: "7.6.0.23012",
    DeviceModel: "20GBD9901",
    DeviceSettings: null,
    FormatVersion: 1,
    OSType: "macOS",
    OSVersion: "26.6.2",
    RequiredPlugins: ["com.rezabehjat.capture", "com.elgato.streamdeck.profile.openchild", "com.elgato.streamdeck.profile.backtoparent"],
  });
  assert.equal(names.filter((n) => ROOT_RE.test(n)).length, 1);
  const rm = JSON.parse(unzipped.get(`${rootDir}manifest.json`)!.toString());
  assert.deepEqual(Object.keys(rm).sort(), ["AppIdentifier", "Device", "Name", "Pages", "Version"]);
  assert.equal(rm.Version, "3.0");
  assert.equal(rm.Name, "Capture");
  assert.deepEqual(rm.Device.Model, "20GBD9901");
  assert.equal(rm.Pages.Current, "00000000-0000-0000-0000-000000000000");
  assert.equal(rm.Pages.Default, layout.home.id);
  assert.deepEqual(rm.Pages.Pages, [layout.home.id]);
  assert.ok(unzipped.has(`${rootDir}Images/`) && unzipped.has(`${rootDir}Profiles/`));
  // one folder per page AND per folder level (the home page too), each with manifest.json + Images/
  assert.equal(pageManifests().size, layout.pages.length);
  for (const p of layout.pages) {
    const dir = `${rootDir}Profiles/${p.id.toUpperCase()}/`;
    assert.ok(unzipped.has(dir) && unzipped.has(`${dir}manifest.json`) && unzipped.has(`${dir}Images/`), p.path);
    const pm = JSON.parse(unzipped.get(`${dir}manifest.json`)!.toString());
    assert.deepEqual(Object.keys(pm), ["Controllers", "Icon", "Name"]);
    assert.equal(pm.Icon, "");
    assert.equal(pm.Name, "");
    assert.deepEqual(pm.Controllers.map((c: { Type: string }) => c.Type), ["Encoder", "Keypad"]);
  }
});

test("UUID case: page folders are upper-case, every reference (Pages, Default, ProfileUUID) is the same UUID in lower case", () => {
  const folders = [...pageManifests().keys()];
  for (const f of folders) assert.match(f, /^[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}$/);
  let refs = 0;
  for (const pm of pageManifests().values())
    for (const c of pm.Controllers)
      for (const a of Object.values(c.Actions)) {
        if (a.UUID !== OPEN_CHILD_UUID) continue;
        refs++;
        assert.match(a.Settings.ProfileUUID, /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/);
        assert.ok(folders.includes(a.Settings.ProfileUUID.toUpperCase()), `ProfileUUID ${a.Settings.ProfileUUID} resolves to a page folder`);
      }
  assert.equal(refs, layout.pages.length - 1, "every page except HOME is opened by exactly one folder key");
});

test("every page has Back at 0,0 except HOME; no page has more than 8 keys or 4 dials", () => {
  const home = layout.home.id.toUpperCase();
  for (const [id, pm] of pageManifests()) {
    const keys = pm.Controllers.find((c) => c.Type === "Keypad")!.Actions;
    const dials = pm.Controllers.find((c) => c.Type === "Encoder")!.Actions;
    assert.ok(Object.keys(keys).length <= 8 && Object.keys(dials).length <= 4, id);
    if (id === home) assert.ok(!Object.values(keys).some((a) => a.UUID === BACK_UUID));
    else assert.equal(keys["0,0"].UUID, BACK_UUID, id);
    for (const pos of Object.keys(keys)) assert.ok((KEY_POSITIONS_ALL as readonly string[]).includes(pos));
  }
});

test("every referenced image exists in its page's Images/ folder and is a 144×144 PNG", () => {
  let n = 0;
  for (const [id, pm] of pageManifests()) {
    for (const c of pm.Controllers)
      for (const a of Object.values(c.Actions))
        for (const s of a.States) {
          n++;
          const img = unzipped.get(`${rootDir}Profiles/${id}/${s.Image}`);
          assert.ok(img, `${id}: ${s.Image}`);
          assert.deepEqual(pngSize(img!), { w: 144, h: 144 });
        }
  }
  assert.ok(n > 100);
});

test("every action UUID is one of ours (visible, not a generic configurable one) or one of the two Elgato folder UUIDs", () => {
  const ours = new Set(manifest.Actions.filter((a) => a.VisibleInActionsList !== false).map((a) => a.UUID));
  const seen = new Set<string>();
  for (const pm of pageManifests().values())
    for (const c of pm.Controllers)
      for (const a of Object.values(c.Actions)) {
        seen.add(a.UUID);
        assert.ok(ours.has(a.UUID) || a.UUID === OPEN_CHILD_UUID || a.UUID === BACK_UUID, a.UUID);
        if (ours.has(a.UUID)) {
          assert.deepEqual(a.Plugin, { Name: "Capture", UUID: "com.rezabehjat.capture", Version: "0.4.1.0" });
          assert.deepEqual(a.Settings, {}, "named actions carry no settings: nothing to choose");
        }
      }
  for (const u of ["com.rezabehjat.capture.command", "com.rezabehjat.capture.tab", "com.rezabehjat.capture.slot", "com.rezabehjat.capture.position", "com.rezabehjat.capture.dial", "com.rezabehjat.capture.toggle"]) assert.ok(!seen.has(u), `${u} is not used`);
});

test("every catalog command except Edit › Model (none catalogued) has a key in the profile, exactly once; all 12 dials appear", () => {
  const used: string[] = [];
  const dials = new Set<string>();
  for (const pm of pageManifests().values())
    for (const c of pm.Controllers)
      for (const a of Object.values(c.Actions)) {
        if (a.UUID.startsWith("com.rezabehjat.capture.cmd.")) used.push(a.UUID);
        if (a.UUID.startsWith("com.rezabehjat.capture.dial.")) dials.add(a.UUID);
      }
  assert.deepEqual([...used].sort(), ENTRIES.map(uuidOf).sort());
  assert.equal(dials.size, 12);
  for (const p of NUMBER_PROPERTIES) assert.ok(dials.has(dialUuid(p)), p.id);
});

test("our actions draw their own label (ShowTitle false); folder / Back / More keys show their title", () => {
  for (const pm of pageManifests().values())
    for (const c of pm.Controllers)
      for (const a of Object.values(c.Actions)) {
        const builtin = a.UUID === OPEN_CHILD_UUID || a.UUID === BACK_UUID;
        for (const s of a.States) {
          assert.equal(s.ShowTitle, builtin, a.UUID);
          assert.equal(s.TitleAlignment, "bottom");
          assert.ok(s.Title.length > 0);
        }
        if (a.UUID === OPEN_CHILD_UUID) assert.equal(a.Name, "Create Folder");
        if (a.UUID === BACK_UUID) assert.equal(a.Name, "Parent Folder");
      }
});

test("images are our own art: every PNG in the zip is byte-identical to a file in profile-art/, named by its content hash", () => {
  const art = new Map<string, string>();
  for (const style of ["key", "folder"]) for (const f of fs.readdirSync(path.join(root, "profile-art", style))) art.set(imageId(fs.readFileSync(path.join(root, "profile-art", style, f))), `${style}/${f}`);
  for (const [n, d] of unzipped) {
    if (!d || !n.endsWith(".png")) continue;
    const id = path.basename(n, ".png");
    assert.ok(art.has(id), `${n} comes from profile-art/`);
    assert.equal(imageId(d), id);
  }
  // the art is generated from src/lib/icons.ts (original line icons) — every glyph the layout needs exists
  const used = iconsUsed(layout);
  for (const i of used.keys) assert.ok(fs.existsSync(path.join(root, "profile-art/key", `${i}.png`)), i);
  for (const i of used.folders) assert.ok(fs.existsSync(path.join(root, "profile-art/folder", `${i}.png`)), i);
});

test("AppIdentifier defaults to /Applications/Capture 2026.app and can be overridden (CAPTURE_APP_PATH)", () => {
  assert.equal(DEFAULT_CAPTURE_APP, "/Applications/Capture 2026.app");
  const rm = (z: Map<string, Buffer | null>) => JSON.parse(z.get(`${rootDir}manifest.json`)!.toString());
  assert.equal(rm(unzipped).AppIdentifier, "/Applications/Capture 2026.app");
  const other = readZip(buildProfileZip(layout, { manifest, image, appPath: "/Applications/Capture 2025.app" }));
  assert.equal(rm(other).AppIdentifier, "/Applications/Capture 2025.app");
});

test("deterministic: two builds are byte-identical; the zip reads back, CRCs included, and `unzip -t` accepts it", () => {
  assert.ok(buildProfileZip(layout, { manifest, image }).equals(zip));
  assert.equal(readZip(zip).size, files.length);
  try {
    const f = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "sdp-")), "t.streamDeckProfile");
    fs.writeFileSync(f, zip);
    const out = execFileSync("unzip", ["-tq", f]).toString();
    assert.match(out, /No errors detected/);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // no unzip installed: skip this part
  }
});

test("the profile bundled in the plugin is what the generator produces (run `npm run gen-profile`) unless it was added by `npm run add-profile`", (t) => {
  const f = path.join(sd, "profiles/Capture.streamDeckProfile");
  assert.ok(fs.existsSync(f), "profiles/Capture.streamDeckProfile exists");
  if (fs.existsSync(path.join(sd, "profiles/CUSTOM"))) return t.skip("custom profile (npm run add-profile)");
  assert.ok(fs.readFileSync(f).equals(zip), "bundled profile is stale: run `npm run gen-profile`");
});

// ---------------------------------------------------------------- the checker itself (it must catch what it claims to)
function mutate(fn: (f: Map<string, Buffer | null>, dir: string) => void): string[] {
  const copy = new Map(unzipped);
  fn(copy, rootDir);
  return checkProfile(copy, manifest);
}
const editPage = (f: Map<string, Buffer | null>, id: string, fn: (pm: any) => void): void => {
  const name = `${rootDir}Profiles/${id.toUpperCase()}/manifest.json`;
  const pm = JSON.parse(f.get(name)!.toString());
  fn(pm);
  f.set(name, Buffer.from(JSON.stringify(pm)));
};
const keysOf = (pm: any): Record<string, any> => pm.Controllers.find((c: any) => c.Type === "Keypad").Actions;
const dialsOf = (pm: any): Record<string, any> => pm.Controllers.find((c: any) => c.Type === "Encoder").Actions;
const child = layout.pages.find((p) => p.path === "view")!;

test("checker: a ProfileUUID in upper case, or pointing nowhere, is reported", () => {
  assert.ok(mutate((f) => editPage(f, layout.home.id, (pm) => (keysOf(pm)["0,0"].Settings.ProfileUUID = keysOf(pm)["0,0"].Settings.ProfileUUID.toUpperCase()))).some((e) => /lower-case/.test(e)));
  assert.ok(mutate((f) => editPage(f, layout.home.id, (pm) => (keysOf(pm)["0,0"].Settings.ProfileUUID = "00000000-0000-4000-8000-000000000000"))).some((e) => /resolves to no page folder/.test(e)));
});
test("checker: a missing Back, a Back on HOME, or Back anywhere but 0,0 is reported", () => {
  assert.ok(mutate((f) => editPage(f, child.id, (pm) => delete keysOf(pm)["0,0"])).some((e) => /Back must be at 0,0/.test(e)));
  assert.ok(mutate((f) => editPage(f, layout.home.id, (pm) => (keysOf(pm)["0,0"] = { ...keysOf(pm)["1,0"], UUID: BACK_UUID }))).some((e) => /HOME must not have a Back/.test(e)));
});
test("checker: more than 8 keys or more than 4 dials is reported", () => {
  assert.ok(mutate((f) => editPage(f, child.id, (pm) => (keysOf(pm)["4,1"] = keysOf(pm)["1,0"]))).some((e) => /more than 8 keys|bad key position/.test(e)));
  assert.ok(mutate((f) => editPage(f, child.id, (pm) => (dialsOf(pm)["4,0"] = dialsOf(pm)["0,0"]))).some((e) => /more than 4 dials|bad dial position/.test(e)));
});
test("checker: a missing or wrongly sized image is reported", () => {
  const img = [...unzipped.keys()].find((n) => n.endsWith(".png"))!;
  assert.ok(mutate((f) => f.delete(img)).some((e) => /does not exist/.test(e)));
  assert.ok(mutate((f) => f.set(img, Buffer.from("not a png"))).some((e) => /not a PNG/.test(e)));
});
test("checker: an action that is not in our manifest, or a hidden generic one, is reported", () => {
  assert.ok(mutate((f) => editPage(f, child.id, (pm) => (keysOf(pm)["1,0"].UUID = "com.example.other.action"))).some((e) => /not in the plugin manifest/.test(e)));
  assert.ok(mutate((f) => editPage(f, child.id, (pm) => (keysOf(pm)["1,0"].UUID = "com.rezabehjat.capture.command"))).some((e) => /hidden/.test(e)));
});
test("checker: a page folder name that is not an upper-case UUID is reported", () => {
  const dir = `${rootDir}Profiles/${child.id.toUpperCase()}/`;
  const bad = `${rootDir}Profiles/${child.id}/`;
  assert.ok(mutate((f) => { for (const [n, d] of [...f]) if (n.startsWith(dir)) { f.delete(n); f.set(n.replace(dir, bad), d); } }).some((e) => /upper-case UUID/.test(e)));
});

// ---------------------------------------------------------------- zip module
test("zip: round trip with directories, CRC check, known CRC-32", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const entries: ZipEntry[] = [{ name: "a/" }, { name: "a/b.txt", data: Buffer.from("héllo ".repeat(100)) }, { name: "a/empty.bin", data: Buffer.alloc(0) }];
  const r = readZip(writeZip(entries));
  assert.deepEqual([...r.keys()], ["a/", "a/b.txt", "a/empty.bin"]);
  assert.equal(r.get("a/"), null);
  assert.equal(r.get("a/b.txt")!.toString(), "héllo ".repeat(100));
  const broken = Buffer.from(writeZip([{ name: "x.txt", data: Buffer.from("payload payload payload") }]));
  broken[broken.indexOf(Buffer.from("x.txt")) + 5] ^= 0xff; // corrupt the stored bytes
  assert.throws(() => readZip(broken));
});
