/**
 * Tests the REAL com.rezabehjat.capture.sdPlugin/ax/worker.js (the JXA source that osascript runs) in Node, against a
 * fake System Events object model that mimics the JXA specifier API the script uses (menuBars[0].menuBarItems.name(),
 * menuItems.enabled(), item.click(), p.frontmost as accessor…).
 *
 * WHAT THIS DOES NOT PROVE: that real JXA on macOS accepts those calls. That can only be verified on a Mac; the plugin
 * therefore validates the worker at start (a read-only `check`) and falls back to per-call osascript if it misbehaves.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(here, "../com.rezabehjat.capture.sdPlugin/ax/worker.js");
const require = createRequire(import.meta.url);
const { createHandler } = require(workerPath) as { createHandler: (SE: unknown, sleep: (s: number) => void) => (req: any) => any };

interface Item {
  name: string | null;
  enabled?: boolean;
  sub?: Item[];
}
interface Top {
  name: string;
  items: Item[];
}

const MENUS: Top[] = [
  { name: "Apple", items: [{ name: "About This Mac" }] },
  { name: "Capture", items: [{ name: "Quit Capture" }] },
  {
    name: "File",
    items: [{ name: "Save" }, { name: "Save As…" }, { name: null }, { name: "Import", sub: [{ name: "Project…" }] }],
  },
  {
    name: "Edit",
    items: [{ name: "Undo Live", enabled: false }, { name: "Redo" }, { name: "Delete", enabled: false }, { name: "Cut" }, { name: "Odd|name\\x é" }],
  },
  {
    name: "View",
    items: [
      { name: "Plot" },
      { name: "Camera", sub: [{ name: "Swing to Front" }, { name: "Position 1" }] },
      { name: "Store Camera", sub: [{ name: "Position 1" }] },
      { name: "Exit Full Screen" },
    ],
  },
];

function mockSE(o: { running?: boolean; front?: boolean; deny?: boolean; clickThrows?: Error; tabs?: string[] } = {}) {
  const state = { front: o.front ?? true, activations: 0, clicks: [] as string[], nameCalls: 0, sleeps: 0 };
  const running = o.running ?? true;
  const deny = (): never => {
    throw new Error("System Events got an error: osascript is not allowed assistive access. (-25211)");
  };
  const menuOf = (items: Item[], path: string[]) => {
    const arr: any = items.map((it, k) => {
      const node: any = {
        click() {
          if (o.clickThrows) throw o.clickThrows;
          state.clicks.push([...path, it.name].join(" > "));
        },
      };
      Object.defineProperty(node, "menus", { get: () => (it.sub ? Object.assign([menuOf(it.sub, [...path, String(it.name)])], {}) : Object.assign([], {})) });
      return node;
    });
    arr.name = () => (state.nameCalls++, items.map((i) => i.name));
    arr.enabled = () => items.map((i) => i.enabled !== false);
    return { menuItems: arr };
  };
  const proc: any = {
    exists: () => running,
    unixId: () => 4711,
  };
  Object.defineProperty(proc, "frontmost", {
    get: () => () => state.front,
    set: (v: boolean) => {
      state.front = v;
      state.activations++;
    },
  });
  Object.defineProperty(proc, "menuBars", {
    get: () => {
      if (o.deny) deny();
      const items: any = MENUS.map((t) => ({ menus: [menuOf(t.items, [t.name])] }));
      items.name = () => MENUS.map((t) => t.name);
      return [{ menuBarItems: items }];
    },
  });
  const tabNames = o.tabs ?? ["Design", "Fixtures", "Universes", "Media", "Snapshots", "Library"];
  proc.windows = Object.assign(
    [
      {
        tabGroups: [
          {
            radioButtons: {
              byName: (n: string) => ({
                name: () => {
                  if (!tabNames.includes(n)) throw new Error("Can’t get radio button (-1728)");
                  return n;
                },
                click: () => state.clicks.push(`tab ${n}`),
              }),
            },
          },
        ],
      },
    ],
    {},
  );
  const SE = { processes: { byName: (n: string) => (n === "Capture" ? proc : { exists: () => false }) } };
  return { SE, state };
}

const run = (o = {}) => {
  const m = mockSE(o);
  const handle = createHandler(m.SE, () => void m.state.sleeps++);
  return { ...m, handle };
};
const T = (path: string[], match = "exact") => ({ path, match });

test("hello / check: pid reported, NOTRUNNING when Capture isn't running, permission problems surface as errors", () => {
  const { handle } = run();
  assert.deepEqual(handle({ id: 1, op: "check" }), { id: 1, ok: true, result: "OK", pid: 4711 });
  assert.equal(handle({ id: 2, op: "hello" }).ok, true);
  assert.equal(run({ running: false }).handle({ id: 3, op: "check" }).result, "NOTRUNNING");
  const denied = run({ deny: true }).handle({ id: 4, op: "check" });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.number, -25211);
  assert.equal(denied.error.internal, false);
  assert.match(denied.error.message, /not allowed assistive access/);
});

test("enabled: one reply for many targets, '?' for missing items, never activates and never clicks", () => {
  const { handle, state } = run({ front: false });
  const r = handle({
    id: 1,
    op: "enabled",
    targets: [T(["Edit", "Undo"], "prefix"), T(["Edit", "Redo"]), T(["Edit", "Delete"]), T(["View", "Camera", "Position 1"]), T(["View", "Nope"]), T(["Edit", "Odd|name\\x é"]), T(["File", "Import", "Project…"]), T(["Bogus", "X"])],
  });
  assert.deepEqual(r, { id: 1, ok: true, result: "0,1,0,1,?,1,1,?", pid: 4711 });
  assert.equal(state.activations, 0, "reading never activates Capture");
  assert.deepEqual(state.clicks, [], "reading never clicks");
});

test("enabled: menus are read once per parent menu (batched), not once per target", () => {
  const { handle, state } = run();
  handle({ id: 1, op: "enabled", targets: [T(["Edit", "Redo"]), T(["Edit", "Delete"]), T(["Edit", "Cut"])] });
  assert.equal(state.nameCalls, 1, "the Edit menu's names are read once for all three targets");
});

test("enabled: a permission error is an error, not a '?'", () => {
  const r = run({ deny: true }).handle({ id: 1, op: "enabled", targets: [T(["Edit", "Cut"])] });
  assert.equal(r.ok, false);
  assert.equal(r.error.number, -25211);
});

test("click: clicks exactly the one item, activating Capture only if it isn't frontmost", () => {
  let x = run({ front: true });
  assert.deepEqual(x.handle({ id: 1, op: "click", ...T(["View", "Plot"]) }), { id: 1, ok: true, result: "OK", pid: 4711 });
  assert.deepEqual(x.state.clicks, ["View > Plot"]);
  assert.equal(x.state.activations, 0);
  x = run({ front: false });
  x.handle({ id: 2, op: "click", ...T(["View", "Camera", "Position 1"]) });
  assert.deepEqual(x.state.clicks, ["View > Camera > Position 1"]);
  assert.equal(x.state.activations, 1);
  x.handle({ id: 3, op: "click", ...T(["View", "Store Camera", "Position 1"]) });
  assert.deepEqual(x.state.clicks.at(-1), "View > Store Camera > Position 1", "same last name, different submenu");
  assert.equal(x.state.activations, 1, "already frontmost now");
});

test("click: prefix (Undo Live), alternates (Enter/Exit Full Screen), ellipsis names, odd characters", () => {
  const { handle, state } = run();
  assert.equal(handle({ id: 1, op: "click", ...T(["Edit", "Redo"], "prefix") }).result, "OK");
  assert.equal(handle({ id: 2, op: "click", ...T(["View", "Enter Full Screen|Exit Full Screen"], "alternates") }).result, "OK");
  assert.equal(handle({ id: 3, op: "click", ...T(["File", "Save As…"]) }).result, "OK");
  assert.equal(handle({ id: 4, op: "click", ...T(["Edit", "Odd|name\\x é"]) }).result, "OK");
  assert.deepEqual(state.clicks, ["Edit > Redo", "View > Exit Full Screen", "File > Save As…", "Edit > Odd|name\\x é"]);
  const undo = handle({ id: 5, op: "click", ...T(["Edit", "Undo"], "prefix") });
  assert.equal(undo.result, "DISABLED", "Undo Live is disabled in the fake");
  assert.equal(state.clicks.length, 4, "a disabled item is never clicked");
});

test("click: exact match means exact; a missing item is a -1728 'no such item' error, not an internal error", () => {
  const { handle, state } = run();
  const r = handle({ id: 1, op: "click", ...T(["Edit", "Undo"]) }); // exact "Undo" ≠ "Undo Live"
  assert.equal(r.ok, false);
  assert.equal(r.error.number, -1728);
  assert.equal(r.error.internal, false);
  const r2 = handle({ id: 2, op: "click", ...T(["Nope", "Thing"]) });
  assert.equal(r2.error.number, -1728);
  assert.deepEqual(state.clicks, []);
});

test("click: when the click itself throws, the reply says the click was attempted (so the plugin never repeats it)", () => {
  const { handle } = run({ clickThrows: new Error("Can’t click (-10000)") });
  const r = handle({ id: 1, op: "click", ...T(["View", "Plot"]) });
  assert.equal(r.ok, false);
  assert.equal(r.error.clickAttempted, true);
  assert.equal(r.error.number, -10000);
});

test("click: NOTRUNNING → nothing touched", () => {
  const x = run({ running: false });
  assert.equal(x.handle({ id: 1, op: "click", ...T(["View", "Plot"]) }).result, "NOTRUNNING");
  assert.equal(x.state.activations, 0);
});

test("tab: clicks the radio button of that tab only; NOTAB if the tab bar has no such button; unknown tab refused", () => {
  const x = run({ front: false });
  assert.equal(x.handle({ id: 1, op: "tab", tab: "Fixtures" }).result, "OK");
  assert.deepEqual(x.state.clicks, ["tab Fixtures"]);
  assert.equal(x.state.activations, 1);
  const y = run({ tabs: ["Design"] });
  assert.equal(y.handle({ id: 2, op: "tab", tab: "Library" }).result, "NOTAB");
  assert.deepEqual(y.state.clicks, []);
  const z = run().handle({ id: 3, op: "tab", tab: "Evil" });
  assert.equal(z.ok, false);
});

test("menubar / dumpTop: records in the AppleScript dump format; names encoded; Apple and Capture menus not descended", () => {
  const { handle, state } = run();
  assert.equal(handle({ id: 1, op: "menubar" }).result, "5");
  assert.equal(handle({ id: 2, op: "dumpTop", index: 0 }).result, "0|1|Apple|1\t");
  assert.equal(handle({ id: 3, op: "dumpTop", index: 1 }).result, "0|1|Capture|1\t");
  const file = handle({ id: 4, op: "dumpTop", index: 2 }).result as string;
  assert.equal(file, "0|1|File|1\t1|1|Save|0\t1|1|Save As\\u{2026}|0\t1|1||0\t1|1|Import|1\t2|1|Project\\u{2026}|0\t");
  const edit = handle({ id: 5, op: "dumpTop", index: 3 }).result as string;
  assert.ok(edit.includes("1|0|Undo Live|0\t"), "disabled state kept");
  assert.ok(edit.includes("1|1|Odd\\u{7C}name\\u{5C}x \\u{E9}|0\t"), "| \\ and non-ASCII encoded");
  assert.ok(/^[\x20-\x7e\t]*$/.test(edit), "ASCII only");
  assert.deepEqual(state.clicks, []);
  assert.equal(state.activations, 0);
});

test("dump output is what parseMenuDump expects", async () => {
  const { parseMenuDump } = await import("../src/lib/menu.ts");
  const { handle } = run();
  let raw = "";
  for (let i = 0; i < 5; i++) raw += "\t" + (handle({ id: i, op: "dumpTop", index: i }).result as string);
  const tree = parseMenuDump(raw);
  assert.deepEqual(tree.map((t) => t.name), ["File", "Edit", "View"], "Apple and Capture dropped, separators dropped");
  assert.deepEqual(tree[0].children.map((c) => c.name), ["Save", "Save As…", "Import"]);
  assert.deepEqual(tree[2].children[1].children.map((c) => c.name), ["Swing to Front", "Position 1"]);
});

test("errors: JS bugs (TypeError…) are flagged internal so the plugin can fall back; unknown op is internal", () => {
  const SE = { processes: { byName: () => ({ exists: () => true, unixId: () => 1, menuBars: undefined }) } };
  const handle = createHandler(SE, () => {});
  const r = handle({ id: 1, op: "check" });
  assert.equal(r.ok, false);
  assert.equal(r.error.internal, true);
  assert.equal(run().handle({ id: 2, op: "frobnicate" }).error.internal, true);
});

// ---------------------------------------------------------------- the stdin/stdout loop

function runLoop(chunks: string[], o = {}) {
  const m = mockSE(o);
  const written: string[] = [];
  let next = 0;
  const stdin = {
    get availableData() {
      const c = chunks[next++];
      return c === undefined ? { length: 0, text: "" } : { length: c.length, text: c };
    },
  };
  const ctx = {
    ObjC: { import() {}, unwrap: (x: { text: string }) => x.text },
    $: {
      NSFileHandle: { fileHandleWithStandardInput: stdin, fileHandleWithStandardOutput: { writeData: (d: { text: string }) => written.push(d.text) } },
      NSString: {
        alloc: { initWithDataEncoding: (d: { text: string }) => d },
        stringWithString: (s: string) => ({ dataUsingEncoding: () => ({ text: s }) }),
      },
      NSUTF8StringEncoding: 4,
      NSThread: { sleepForTimeInterval() {} },
    },
    Application: () => m.SE,
  };
  vm.runInNewContext(fs.readFileSync(workerPath, "utf8"), ctx);
  return { written, state: m.state };
}

test("loop: newline-delimited JSON in, one JSON line out per request, requests split across reads, EOF ends the loop", () => {
  const a = JSON.stringify({ id: 1, op: "click", path: ["View", "Plot"], match: "exact" });
  const b = JSON.stringify({ id: 2, op: "enabled", targets: [{ path: ["Edit", "Redo"], match: "exact" }] });
  const { written, state } = runLoop([a.slice(0, 20), a.slice(20) + "\n" + b.slice(0, 5), b.slice(5) + "\n", "\n  \n"]);
  assert.equal(written.length, 2);
  const [r1, r2] = written.map((w) => JSON.parse(w));
  assert.deepEqual([r1.id, r1.ok, r1.result], [1, true, "OK"]);
  assert.deepEqual([r2.id, r2.ok, r2.result], [2, true, "1"]);
  assert.ok(written.every((w) => w.endsWith("\n") && w.indexOf("\n") === w.length - 1), "exactly one line per reply");
  assert.deepEqual(state.clicks, ["View > Plot"]);
});

test("loop: a bad line gets an error reply and the loop carries on; replies are ASCII-only JSON", () => {
  const { written } = runLoop(["not json\n", JSON.stringify({ id: 9, op: "dumpTop", index: 2 }) + "\n"]);
  assert.equal(written.length, 2);
  assert.equal(JSON.parse(written[0]).ok, false);
  const r = JSON.parse(written[1]);
  assert.equal(r.id, 9);
  assert.ok(/^[\x20-\x7e\n]*$/.test(written[1]));
});
