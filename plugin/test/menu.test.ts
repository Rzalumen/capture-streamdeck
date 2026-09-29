import test from "node:test";
import assert from "node:assert/strict";
import { flattenMenu, parseEnabledBatch, parseMenuDump, suggestTarget, targetTitle } from "../src/lib/menu.ts";

/** JS twin of the AppleScript `enc` handler. */
const enc = (s: string): string =>
  [...s]
    .map((c) => {
      const cp = c.codePointAt(0)!;
      return cp < 32 || cp > 126 || cp === 124 || cp === 92 ? `\\u{${cp.toString(16).toUpperCase()}}` : c;
    })
    .join("");

type Item = [depth: number, name: string, enabled?: boolean, sub?: boolean];
const dump = (items: Item[]) =>
  items.map(([d, n, e = true, s = false]) => `${d}|${e ? 1 : 0}|${enc(n)}|${s ? 1 : 0}`).join("\t") + "\t";

/** Structure of the real Capture dump from Reza's Mac (handoff 07), plus the macOS-injected items. */
const REAL: Item[] = [
  [0, "Apple", true, true],
  [0, "Capture", true, true],
  [0, "File", true, true],
  [1, "New"],
  [1, "Open…"],
  [1, "Open Recent", true, true],
  [2, "Show A.c3d"],
  [2, "Show B.c3d"],
  [2, "1"], // separator
  [1, "Save"],
  [1, "Save As…"],
  [1, "Export", true, true],
  [2, "Focus Sheets…"],
  [2, "Documentation…"],
  [0, "Edit", true, true],
  [1, "Undo Live", false],
  [1, "Redo", false],
  [1, "2"], // separator
  [1, "Cut"],
  [1, "Delete"],
  [1, "Select All"],
  [1, "Select", true, true],
  [2, "By Layer"],
  [2, "By Fixture Type"],
  [1, "Sequential", true, true],
  [2, "Unit…"],
  [2, "Circuit…"],
  [1, "3"],
  [1, "Writing Tools", true, true],
  [2, "Proofread"],
  [2, "Rewrite"],
  [1, "AutoFill", true, true],
  [2, "Contact…"],
  [1, "Start Dictation…"],
  [1, "Emoji & Symbols"],
  [0, "View", true, true],
  [1, "Wireframe"],
  [1, "Plot"],
  [1, "Live"],
  [1, "Camera", true, true],
  [2, "Swing to Top"],
  [2, "Swing to Front"],
  [2, "4"],
  [2, "Position 1"],
  [1, "Store Camera", true, true],
  [2, "Position 1"],
  [1, "Grid"],
  [1, "Save Image…"],
  [1, "Enter Full Screen"],
  [0, "Navigate", true, true],
  [1, "Alpha View"],
  [1, "Beta View"],
  [0, "Window", true, true],
  [1, "Minimize"],
  [1, "Arrangements", true, true],
  [2, "Quad"],
  [2, "Wide"],
];

test("parse real dump: separators and system items excluded", () => {
  const tree = parseMenuDump(dump(REAL));
  assert.deepEqual(
    tree.map((t) => t.name),
    ["File", "Edit", "View", "Navigate", "Window"],
    "Apple and Capture app menus dropped",
  );
  const file = tree.find((t) => t.name === "File")!;
  assert.deepEqual(file.children.map((c) => c.name), ["New", "Open…", "Save", "Save As…", "Export"]); // Open Recent gone
  const edit = tree.find((t) => t.name === "Edit")!;
  const names = edit.children.map((c) => c.name);
  for (const bad of ["Writing Tools", "AutoFill", "Start Dictation…", "Emoji & Symbols", "1", "2", "3"]) assert.ok(!names.includes(bad), bad);
  assert.deepEqual(names, ["Undo Live", "Redo", "Cut", "Delete", "Select All", "Select", "Sequential"]);
  assert.equal(edit.children[0].enabled, false);
  const cam = tree.find((t) => t.name === "View")!.children.find((c) => c.name === "Camera")!;
  assert.deepEqual(cam.children.map((c) => c.name), ["Swing to Top", "Swing to Front", "Position 1"]);
});

test("flatten: leaf commands with paths; dynamic titles normalised", () => {
  const flat = flattenMenu(parseMenuDump(dump(REAL)));
  const byLabel = new Map(flat.map((f) => [f.label, f]));
  assert.deepEqual(byLabel.get("View › Camera › Swing to Top")!.path, ["View", "Camera", "Swing to Top"]);
  assert.deepEqual(byLabel.get("View › Store Camera › Position 1")!.path, ["View", "Store Camera", "Position 1"]);
  const undo = byLabel.get("Edit › Undo Live")!;
  assert.deepEqual([undo.path, undo.match, undo.enabled], [["Edit", "Undo"], "prefix", false]);
  assert.equal(byLabel.get("Edit › Redo")!.match, "prefix"); // dynamic title → always prefix
  const fs = byLabel.get("View › Enter Full Screen")!;
  assert.deepEqual([fs.path, fs.match], [["View", "Enter Full Screen|Exit Full Screen"], "alternates"]);
  assert.ok(!byLabel.has("View › Camera"), "submenu parents are not commands");
  assert.ok(byLabel.has("Edit › Sequential › Unit…"));
  assert.ok(byLabel.has("Window › Arrangements › Quad"));
});

test("suggestTarget", () => {
  assert.deepEqual(suggestTarget(["Edit", "Undo Live"]), { path: ["Edit", "Undo"], match: "prefix" });
  assert.deepEqual(suggestTarget(["Edit", "Redo Delete"]), { path: ["Edit", "Redo"], match: "prefix" });
  assert.deepEqual(suggestTarget(["Edit", "Undo"]), { path: ["Edit", "Undo"], match: "prefix" });
  assert.deepEqual(suggestTarget(["View", "Exit Full Screen"]).match, "alternates");
  assert.deepEqual(suggestTarget(["View", "Grid"]), { path: ["View", "Grid"], match: "exact" });
});

test("targetTitle", () => {
  assert.equal(targetTitle({ path: ["Edit", "Undo"], match: "prefix" }), "Undo");
  assert.equal(targetTitle({ path: ["View", "Enter Full Screen|Exit Full Screen"], match: "alternates" }), "Enter Full Screen");
  assert.equal(targetTitle({ path: ["Edit", "Duplicate…"], match: "exact" }), "Duplicate…");
});

test("parse tolerates CR/LF separators, junk lines and empty input", () => {
  assert.deepEqual(parseMenuDump(""), []);
  const t = parseMenuDump("0|1|File|1\r\n1|1|Save|0\nnonsense\n1|0|Print\\u{2026}|0\n");
  assert.deepEqual(t[0].children.map((c) => c.name), ["Save", "Print…"]);
});

test("enabled batch parsing", () => {
  assert.deepEqual(parseEnabledBatch("1,0,?", 3), [true, false, null]);
  assert.deepEqual(parseEnabledBatch("1", 3), [true, null, null]);
  assert.deepEqual(parseEnabledBatch("", 2), [null, null]);
});
