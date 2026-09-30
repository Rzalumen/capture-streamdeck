import test from "node:test";
import assert from "node:assert/strict";
import { ENTRIES, type CatalogEntry } from "../src/catalog/index.ts";
import { AxBridge, type ExecResult, type Runner } from "../src/lib/axBridge.ts";
import { MenuCache } from "../src/lib/menuCache.ts";
import { diffCatalog, flattenMenu, normName, parseMenuDump, resolveMissing } from "../src/lib/menu.ts";

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", code: 0 });
const rec = (rows: [number, string][]) => rows.map(([d, n]) => `${d}|1|${n}|0`).join("\t") + "\t";
const DUMP = rec([
  [0, "Apple"], [0, "Capture"],
  [0, "File"], [1, "New"], [1, "Open…"], [1, "Save"], [1, "Save As…"],
  [0, "Edit"], [1, "Undo Live"], [1, "Copy"], [1, "Focus…"], [1, "Zap Thing…"],
  [0, "View"], [1, "Plot"], [1, "Camera"], [2, "Swing to Front"], [1, "Enter Full Screen"],
]);

const logs: string[] = [];
const logger = { trace() {}, debug() {}, info: (m: string) => logs.push("I " + m), warn: (m: string) => logs.push("W " + m), error: (m: string) => logs.push("E " + m) };

test("MenuCache: read once (read-only), served from memory, rebuilt when Capture's pid changes or on a forced refresh", async () => {
  const scripts: string[] = [];
  const runner: Runner = async (lines) => (scripts.push(lines.join("\n")), ok(DUMP));
  const ax = new AxBridge({ runner });
  const cache = new MenuCache(ax, { logger });
  const a = await cache.ensure();
  assert.ok(a.commands.length > 5);
  assert.equal(cache.builds, 1);
  await cache.ensure();
  await cache.ensure();
  assert.equal(cache.builds, 1, "served from the cache");
  await cache.ensure(true);
  assert.equal(cache.builds, 2, "Refresh re-reads");
  for (const s of scripts) {
    assert.ok(!/\bclick\b/.test(s), "reading the tree never clicks");
    assert.ok(!s.includes("set frontmost to true"), "reading the tree never activates Capture");
  }
  // a new Capture launch has a new pid → rebuilt
  (ax as any).pid = 100;
  await cache.ensure(true);
  assert.equal(cache.pid, 100);
  const n = cache.builds;
  await cache.ensure();
  assert.equal(cache.builds, n, "same pid: still fresh");
  (ax as any).pid = 200;
  await cache.ensure();
  assert.equal(cache.builds, n + 1, "pid changed: rebuilt");
  assert.equal(cache.pid, 200);
});

test("MenuCache: concurrent requests share one read; a forced read after an in-flight one reads again", async () => {
  let reads = 0;
  const runner: Runner = async () => (reads++, await new Promise((r) => setTimeout(r, 20)), ok(DUMP));
  const cache = new MenuCache(new AxBridge({ runner }), { logger });
  await Promise.all([cache.ensure(), cache.ensure(), cache.ensure()]);
  assert.equal(reads, 1);
  const p = cache.ensure(true);
  const q = cache.ensure(true);
  await Promise.all([p, q]);
  assert.ok(reads >= 2 && reads <= 3);
});

test("MenuCache: errors are kept as a readable message and the previous commands stay usable", async () => {
  let fail = false;
  const runner: Runner = async () => (fail ? { stdout: "", stderr: "not allowed assistive access. (-25211)", code: 1 } : ok(DUMP));
  const cache = new MenuCache(new AxBridge({ runner }), { logger });
  await cache.ensure();
  fail = true;
  const r = await cache.ensure(true);
  assert.match(r.error ?? "", /Allow Access/);
  assert.ok(r.commands.length > 0);
  const notRunning = new MenuCache(new AxBridge({ runner: async () => ok("NOTRUNNING") }), { logger });
  assert.match((await notRunning.ensure()).error ?? "", /not running/i);
});

test("MenuCache: onBuilt fires; the catalog diff is logged (missing entries and Capture commands nobody catalogued)", async () => {
  logs.length = 0;
  const cache = new MenuCache(new AxBridge({ runner: async () => ok(DUMP) }), { logger, entries: ENTRIES });
  let built = 0;
  cache.onBuilt = () => built++;
  await cache.ensure();
  assert.equal(built, 1);
  const missing = logs.find((l) => l.startsWith("W Catalog entries not found"));
  assert.ok(missing && missing.includes("View > Wireframe"), "entries absent from this fake Capture are reported");
  const extra = logs.find((l) => l.includes("no catalog entry"));
  assert.ok(extra && extra.includes("Edit > Zap Thing…"), "a Capture command with no entry is listed");
  assert.ok(!extra.includes("Edit > Focus…"), "Focus… is in the catalog (Patch & Focus)");
});

const live = flattenMenu(parseMenuDump(DUMP));

test("diffCatalog: missing vs extra; New / Open… are deliberately not catalogued; names compare ignoring case and …", () => {
  const entries = [
    { menuPath: ["View", "Plot"], match: "exact" as const },
    { menuPath: ["View", "Wireframe"], match: "exact" as const },
    { menuPath: ["Edit", "Undo"], match: "prefix" as const },
    { menuPath: ["Edit", "focus..."], match: "exact" as const },
    { menuPath: ["View", "Enter Full Screen|Exit Full Screen"], match: "alternates" as const },
  ];
  const d = diffCatalog(live, entries);
  assert.deepEqual(d.missing.map((e) => e.menuPath.join(" > ")), ["View > Wireframe"]);
  const extra = d.extra.map((c) => c.path.join(" > "));
  assert.ok(extra.includes("File > Save") && extra.includes("Edit > Copy") && extra.includes("View > Camera > Swing to Front"));
  assert.ok(!extra.some((p) => /File > New|File > Open/.test(p)), "New and Open… excluded");
  assert.ok(!extra.includes("View > Plot") && !extra.includes("Edit > Undo"), "covered ones are not extra");
  assert.equal(normName("Focus…"), normName("FOCUS..."));
});

test("resolveMissing: fallback path first, else the one same-named command in the same top menu; ambiguity → undefined", () => {
  const entry = { menuPath: ["File", "Import", "Project…"], match: "exact" as const, fallbackPaths: [["File", "Import Project…"]] };
  const l2 = flattenMenu(parseMenuDump(rec([[0, "File"], [1, "Import Project…"], [1, "Save"]])));
  assert.deepEqual(resolveMissing(entry, l2)?.path, ["File", "Import Project…"]);
  const moved = { menuPath: ["Edit", "Save"], match: "exact" as const };
  assert.deepEqual(resolveMissing({ menuPath: ["File", "Nope", "Save"], match: "exact" }, l2)?.path, ["File", "Save"], "found by name in the same menu");
  assert.equal(resolveMissing(moved, l2), undefined, "different top menu: not guessed");
  const dup = flattenMenu(parseMenuDump(rec([[0, "File"], [1, "Save"], [1, "Sub"], [2, "Save"]])).slice());
  assert.equal(resolveMissing({ menuPath: ["File", "X", "Save"], match: "exact" }, dup), undefined, "two candidates: never guess");
});

test("MenuCache.effective: the catalog path while it exists (or the tree is unread), otherwise the healed path", async () => {
  const cache = new MenuCache(new AxBridge({ runner: async () => ok(rec([[0, "File"], [1, "Import Project…"], [1, "Save"], [0, "View"], [1, "Plot"]])) }), { logger });
  const imp = ENTRIES.find((e) => e.id === "import-project") as CatalogEntry;
  const plot = ENTRIES.find((e) => e.id === "plot" && e.category === "view") as CatalogEntry;
  assert.deepEqual(cache.effective(imp).path, imp.menuPath, "tree not read yet: never guess");
  await cache.ensure();
  assert.deepEqual(cache.effective(imp).path, ["File", "Import Project…"], "fallback path used");
  assert.deepEqual(cache.effective(plot).path, ["View", "Plot"]);
  const wire = ENTRIES.find((e) => e.id === "wireframe") as CatalogEntry;
  assert.deepEqual(cache.effective(wire).path, wire.menuPath, "nothing better known: keep the catalog path");
});
