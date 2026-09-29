import test from "node:test";
import assert from "node:assert/strict";
import {
  asList,
  asString,
  buildCheck,
  buildClickMenu,
  buildClickTab,
  buildEnabledBatch,
  buildMenuDump,
  candidates,
  decodeName,
  type MenuTarget,
} from "../src/lib/applescript.ts";

const ascii = (lines: string[]) => lines.every((l) => /^[\x20-\x7e]*$/.test(l));

test("asString: plain text, quotes, backslashes", () => {
  assert.equal(asString("View"), '"View"');
  assert.equal(asString('say "hi"'), '"say \\"hi\\""');
  assert.equal(asString("a\\b"), '"a\\\\b"');
  assert.equal(asString(""), '""');
});

test("asString: ampersand stays literal inside the quotes", () => {
  assert.equal(asString("Emoji & Symbols"), '"Emoji & Symbols"');
});

test("asString: ellipsis and other non-ASCII become (character id N)", () => {
  assert.equal(asString("Duplicate…"), '("Duplicate" & (character id 8230))');
  assert.equal(asString("…"), "(character id 8230)");
  assert.equal(asString("A\nB"), '("A" & (character id 10) & "B")');
  assert.equal(asString("é"), "(character id 233)");
  assert.equal(asString("😀"), "(character id 128512)");
});

test("asString: injection attempt stays inside one string literal", () => {
  const s = asString('x" & (do shell script "rm -rf ~") & "');
  assert.equal(s, '"x\\" & (do shell script \\"rm -rf ~\\") & \\""');
});

test("asList", () => {
  assert.equal(asList(["Camera", "Position 1"]), '{"Camera", "Position 1"}');
  assert.equal(asList([]), "{}");
});

test("nested submenu click script: View > Camera > Position 1", () => {
  const t: MenuTarget = { path: ["View", "Camera", "Position 1"], match: "exact" };
  const lines = buildClickMenu(t);
  const call = lines.find((l) => l.startsWith("return my act("))!;
  assert.equal(call, 'return my act("Capture", "View", {"Camera"}, "exact", {"Position 1"}, "click")');
  assert.ok(ascii(lines), "script must be pure ASCII");
});

test("two-level path (File > Save) has no parents", () => {
  const call = buildClickMenu({ path: ["File", "Save"], match: "exact" }).find((l) => l.startsWith("return my act("))!;
  assert.equal(call, 'return my act("Capture", "File", {}, "exact", {"Save"}, "click")');
});

test("ellipsis command name is escaped in the script", () => {
  const call = buildClickMenu({ path: ["Edit", "Duplicate…"], match: "exact" }).find((l) => l.includes("my act("))!;
  assert.ok(call.includes('("Duplicate" & (character id 8230))'));
});

test("prefix and alternates modes", () => {
  const p = buildClickMenu({ path: ["Edit", "Undo"], match: "prefix" }).find((l) => l.includes("my act("))!;
  assert.ok(p.includes('"prefix", {"Undo"}'));
  const a: MenuTarget = { path: ["View", "Enter Full Screen|Exit Full Screen"], match: "alternates" };
  assert.deepEqual(candidates(a), ["Enter Full Screen", "Exit Full Screen"]);
  assert.ok(buildClickMenu(a).find((l) => l.includes("my act("))!.includes('"alternates", {"Enter Full Screen", "Exit Full Screen"}'));
});

test("click script activates Capture only if not frontmost, and guards on process existence (never launches)", () => {
  const text = buildClickMenu({ path: ["View", "Wireframe"], match: "exact" }).join("\n");
  assert.ok(text.includes('exists process "Capture"'));
  assert.ok(text.includes("if not frontmost then"));
  assert.ok(text.includes("set frontmost to true"));
  assert.ok(!/launch|activate|open application|keystroke|key code|click at|mouse/i.test(text.replace(/\bclick\b/g, "")));
  // `tell application "Capture"` would launch it — must never appear
  assert.ok(!text.includes('application "Capture"'));
});

test("enabled batch: one script, never activates, never clicks", () => {
  const lines = buildEnabledBatch([
    { path: ["Edit", "Undo"], match: "prefix" },
    { path: ["Edit", "Delete"], match: "exact" },
    { path: ["View", "Camera", "Swing to Top"], match: "exact" },
  ]);
  const text = lines.join("\n");
  assert.equal(lines.filter((l) => l.includes("my act(")).length, 3);
  assert.ok(lines.filter((l) => l.includes("my act(")).every((l) => l.endsWith('"enabled")')));
  assert.ok(!text.includes("frontmost to true"));
  // the shared handler contains `click hit`, but it is only reachable when wantWhat is "click"; the batch never asks for that
  assert.ok(lines.filter((l) => l.includes("my act(")).every((l) => !l.includes('"click")')));
  assert.ok(text.includes('if wantWhat is "enabled" then'));
  assert.ok(text.includes("isPermissionError"));
  assert.ok(ascii(lines));
});

test("tab click script finds the window with tab group 1 and clicks only that radio button", () => {
  const lines = buildClickTab("Fixtures");
  const text = lines.join("\n");
  assert.ok(text.includes("repeat with w in (windows)"));
  assert.ok(text.includes("set g to tab group 1 of w"));
  assert.ok(text.includes('set rb to radio button "Fixtures" of g'));
  assert.equal(text.match(/\bclick\b/g)!.length, 1);
  assert.throws(() => buildClickTab("Bogus" as never));
});

test("invalid targets are rejected before any script is built", () => {
  assert.throws(() => buildClickMenu({ path: ["View"], match: "exact" }));
  assert.throws(() => buildClickMenu({ path: ["View", ""], match: "exact" }));
  assert.throws(() => buildClickMenu({ path: ["View", "X"], match: "regex" as never }));
});

test("check and dump scripts are ASCII and read-only", () => {
  for (const lines of [buildCheck(), buildMenuDump()]) {
    assert.ok(ascii(lines));
    const text = lines.join("\n");
    assert.ok(!/\bclick\b/.test(text));
    assert.ok(!text.includes("frontmost to true"));
  }
});

test("decodeName", () => {
  assert.equal(decodeName("Duplicate\\u{2026}"), "Duplicate…");
  assert.equal(decodeName("A\\u{7C}B"), "A|B");
  assert.equal(decodeName("plain"), "plain");
});
