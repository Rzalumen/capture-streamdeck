import test from "node:test";
import assert from "node:assert/strict";
import { ENTRIES, type CatalogEntry } from "../src/catalog/index.ts";
import { AxBridge, type ExecResult, type Runner } from "../src/lib/axBridge.ts";
import { MenuCache } from "../src/lib/menuCache.ts";
import { parseMenuDump } from "../src/lib/menu.ts";

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", code: 0 });
const rec = (rows: [number, string][]) => rows.map(([d, n]) => `${d}|1|${n}|0`).join("\t") + "\t";
const DUMP = rec([
  [0, "Apple"], [0, "Capture"],
  [0, "File"], [1, "New"], [1, "Open..."], [1, "Save"], [1, "Save As..."],
  [0, "Edit"], [1, "Undo Live"], [1, "Copy"], [1, "Focus..."], [1, "Zap Thing..."],
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

test("MenuCache: onBuilt fires; the startup report lists missing entries (with the closest live titles) and Capture commands nobody catalogued", async () => {
  logs.length = 0;
  const cache = new MenuCache(new AxBridge({ runner: async () => ok(DUMP) }), { logger, entries: ENTRIES });
  let built = 0;
  cache.onBuilt = () => built++;
  await cache.ensure();
  assert.equal(built, 1);
  const missing = logs.find((l) => l.startsWith("W Catalog entries not found"));
  assert.ok(missing && missing.includes("View > Wireframe"), "entries absent from this fake Capture are reported");
  assert.match(missing, /View > Wireframe \(closest: View > /, "...with the closest live titles");
  const extra = logs.find((l) => l.includes("no catalog entry"));
  assert.ok(extra && extra.includes("Edit > Zap Thing..."), "a Capture command with no entry is listed");
  assert.ok(!extra.includes("Edit > Focus..."), "Focus... is in the catalog (Patch & Focus)");
});

test("MenuCache.resolve: pending until the tree is read; then Capture's exact titles (Patch… ↔ Patch...), or missing with suggestions", async () => {
  const cache = new MenuCache(new AxBridge({ runner: async () => ok(DUMP) }), { logger });
  const focus = ENTRIES.find((e) => e.id === "focus" && e.category === "patch") as CatalogEntry;
  const plot = ENTRIES.find((e) => e.id === "plot" && e.category === "view") as CatalogEntry;
  const wire = ENTRIES.find((e) => e.id === "wireframe") as CatalogEntry;
  const p0 = cache.resolve(focus);
  assert.equal(p0.state, "pending", "tree not read yet: nothing is verified");
  assert.deepEqual(p0.target.path, ["Edit", "Focus..."], "...the catalog path, in ASCII");
  await cache.ensure();
  assert.deepEqual(cache.resolve(focus), { state: "ok", target: { path: ["Edit", "Focus..."], match: "exact" }, via: "path" });
  assert.deepEqual(cache.resolve(plot).target.path, ["View", "Plot"]);
  const w = cache.resolve(wire);
  assert.equal(w.state, "missing");
  assert.ok(w.state === "missing" && w.suggestions.length > 0 && w.suggestions.every((x) => x.startsWith("View > ")));
  // the same catalog entry in the other spelling still resolves to the live title
  const unicode = cache.resolve({ menuPath: ["Edit", "Focus…"], match: "exact" });
  assert.deepEqual(unicode.target.path, ["Edit", "Focus..."]);
});
