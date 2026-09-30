/**
 * Structural checks of a built `.streamDeckProfile` (as unzipped by readZip) against the plugin manifest.
 * Used by the generator (refuses to write a bad profile), the tests, and the committed-file test.
 */
import type { Manifest } from "../catalog/manifest.js";
import { BACK_UUID, COMMAND_SLOTS, DIAL_POSITIONS, KEY_POSITIONS_ALL, OPEN_CHILD_UUID } from "./layout.js";
import { PLUGIN_UUID } from "./build.js";

const UPPER = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface ActionJson {
  ActionID?: string;
  Name?: string;
  UUID?: string;
  Plugin?: { UUID?: string };
  Settings?: Record<string, unknown>;
  States?: { Image?: string; Title?: string }[];
}
interface PageJson {
  Controllers?: { Type: string; Actions: Record<string, ActionJson> }[];
}

export function pngSize(buf: Buffer): { w: number; h: number } | undefined {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

export function checkProfile(files: Map<string, Buffer | null>, manifest: Manifest): string[] {
  const errs: string[] = [];
  const err = (m: string): void => void errs.push(m);
  const text = (name: string): string | undefined => files.get(name)?.toString("utf8");
  const parse = <T>(name: string): T | undefined => {
    const t = text(name);
    if (t === undefined) {
      err(`missing ${name}`);
      return undefined;
    }
    try {
      return JSON.parse(t) as T;
    } catch {
      err(`${name} is not valid JSON`);
      return undefined;
    }
  };

  // --- package.json
  const pkg = parse<{ FormatVersion?: number; DeviceModel?: string; RequiredPlugins?: string[] }>("package.json");
  if (pkg) {
    if (pkg.FormatVersion !== 1) err("package.json FormatVersion must be 1");
    if (pkg.DeviceModel !== "20GBD9901") err("package.json DeviceModel must be 20GBD9901 (Stream Deck+)");
    for (const p of [PLUGIN_UUID, OPEN_CHILD_UUID, BACK_UUID]) if (!pkg.RequiredPlugins?.includes(p)) err(`package.json RequiredPlugins lacks ${p}`);
  }

  // --- root profile folder
  const roots = [...files.keys()].filter((n) => /^Profiles\/[^/]+\.sdProfile\/$/.test(n));
  if (roots.length !== 1) {
    err(`expected exactly one Profiles/<UUID>.sdProfile/ folder, found ${roots.length}`);
    return errs;
  }
  const rootDir = roots[0];
  const rootUuid = /^Profiles\/([^/]+)\.sdProfile\/$/.exec(rootDir)?.[1] ?? "";
  if (!UPPER.test(rootUuid)) err(`root folder name ${rootUuid} is not an upper-case UUID`);
  for (const d of ["Images/", "Profiles/"]) if (!files.has(rootDir + d)) err(`missing ${rootDir}${d}`);
  const root = parse<{ AppIdentifier?: string; Device?: { Model?: string; UUID?: string }; Name?: string; Version?: string; Pages?: { Current?: string; Default?: string; Pages?: string[] } }>(`${rootDir}manifest.json`);

  // --- page folders
  const pageDirs = new Map<string, string>(); // upper-case uuid → dir
  for (const n of files.keys()) {
    const m = new RegExp(`^${rootDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}Profiles/([^/]+)/$`).exec(n);
    if (m) {
      if (!UPPER.test(m[1])) err(`page folder ${m[1]} is not an upper-case UUID`);
      pageDirs.set(m[1], n);
      if (!files.has(`${n}manifest.json`)) err(`${n} has no manifest.json`);
      if (!files.has(`${n}Images/`)) err(`${n} has no Images/ folder`);
    }
  }

  if (root) {
    if (root.Version !== "3.0") err("root manifest Version must be 3.0");
    if (!root.AppIdentifier) err("root manifest has no AppIdentifier");
    if (root.Device?.Model !== "20GBD9901") err("root manifest Device.Model must be 20GBD9901");
    const def = root.Pages?.Default;
    if (!def || !LOWER.test(def)) err(`Pages.Default ${def} is not a lower-case UUID`);
    else if (!pageDirs.has(def.toUpperCase())) err(`Pages.Default ${def} has no page folder`);
    if (root.Pages?.Pages?.length !== 1 || root.Pages.Pages[0] !== def) err("Pages.Pages must list exactly the home page");
    if (root.Pages?.Current !== "00000000-0000-0000-0000-000000000000") err("Pages.Current must be the all-zero UUID");
  }
  const home = root?.Pages?.Default?.toUpperCase();

  // --- pages
  const visible = new Map(manifest.Actions.filter((a) => a.VisibleInActionsList !== false).map((a) => [a.UUID, a]));
  const allUuids = new Set(manifest.Actions.map((a) => a.UUID));
  const seenAction = new Set<string>();
  const referenced = new Map<string, string[]>(); // child page → parents
  for (const [pageUuid, dir] of pageDirs) {
    const page = parse<PageJson>(`${dir}manifest.json`);
    if (!page) continue;
    const enc = page.Controllers?.find((c) => c.Type === "Encoder")?.Actions ?? {};
    const pad = page.Controllers?.find((c) => c.Type === "Keypad")?.Actions ?? {};
    const at = `page ${pageUuid.slice(0, 8)}`;
    if (Object.keys(pad).length > 8) err(`${at}: more than 8 keys`);
    if (Object.keys(enc).length > 4) err(`${at}: more than 4 dials`);
    for (const pos of Object.keys(pad)) if (!(KEY_POSITIONS_ALL as readonly string[]).includes(pos)) err(`${at}: bad key position ${pos}`);
    for (const pos of Object.keys(enc)) if (!(DIAL_POSITIONS as readonly string[]).includes(pos)) err(`${at}: bad dial position ${pos}`);
    if (Object.keys(enc).length !== 4) err(`${at}: every page must have its own four dials`);

    const back = pad["0,0"];
    if (pageUuid === home) {
      if (Object.values(pad).some((a) => a.UUID === BACK_UUID)) err("HOME must not have a Back key");
      if (Object.keys(pad).length !== 8 || Object.values(pad).some((a) => a.UUID !== OPEN_CHILD_UUID)) err("HOME must be 8 folder keys");
    } else {
      if (back?.UUID !== BACK_UUID) err(`${at}: Back must be at 0,0`);
      if (Object.entries(pad).some(([p, a]) => p !== "0,0" && a.UUID === BACK_UUID)) err(`${at}: Back anywhere but 0,0`);
      for (const p of Object.keys(pad)) if (p !== "0,0" && !(COMMAND_SLOTS as readonly string[]).includes(p)) err(`${at}: key at ${p}`);
    }

    for (const [pos, a] of [...Object.entries(pad), ...Object.entries(enc)]) {
      const u = a.UUID ?? "";
      if (u === OPEN_CHILD_UUID) {
        const target = a.Settings?.ProfileUUID;
        if (typeof target !== "string" || !LOWER.test(target)) err(`${at} ${pos}: ProfileUUID ${String(target)} is not a lower-case UUID`);
        else {
          if (!pageDirs.has(target.toUpperCase())) err(`${at} ${pos}: ProfileUUID ${target} resolves to no page folder`);
          referenced.set(target.toUpperCase(), [...(referenced.get(target.toUpperCase()) ?? []), pageUuid]);
        }
        if (Object.keys(a.Settings ?? {}).length !== 1) err(`${at} ${pos}: folder key Settings must be only ProfileUUID`);
      } else if (u === BACK_UUID) {
        /* ok */
      } else {
        if (!allUuids.has(u)) err(`${at} ${pos}: action ${u} is not in the plugin manifest`);
        else if (!visible.has(u)) err(`${at} ${pos}: action ${u} is hidden (a configurable generic action)`);
        if (a.Plugin?.UUID !== PLUGIN_UUID) err(`${at} ${pos}: ${u} has no Plugin block`);
        const m = manifest.Actions.find((x) => x.UUID === u);
        if (m && a.Name !== m.Name) err(`${at} ${pos}: Name "${a.Name}" differs from the manifest's "${m.Name}"`);
        if (m && (m.Controllers.includes("Encoder") ? enc[pos] !== a : pad[pos] !== a)) err(`${at} ${pos}: ${u} is on the wrong controller`);
        if (m && a.States?.length !== m.States.length) err(`${at} ${pos}: ${u} has ${a.States?.length} states, the manifest ${m.States.length}`);
      }
      if (!a.ActionID || !LOWER.test(a.ActionID)) err(`${at} ${pos}: bad ActionID`);
      else if (seenAction.has(a.ActionID)) err(`${at} ${pos}: duplicate ActionID`);
      else seenAction.add(a.ActionID);
      for (const s of a.States ?? []) {
        if (!s.Image) continue;
        const img = files.get(`${dir}${s.Image}`);
        if (!img) err(`${at} ${pos}: image ${s.Image} does not exist in ${dir}`);
        else {
          const sz = pngSize(img);
          if (!sz) err(`${at} ${pos}: ${s.Image} is not a PNG`);
          else if (sz.w !== 144 || sz.h !== 144) err(`${at} ${pos}: ${s.Image} is ${sz.w}×${sz.h}, not 144×144`);
        }
      }
    }
  }
  // every non-home page is opened by exactly one folder key, and everything is reachable from HOME
  for (const p of pageDirs.keys()) {
    if (p === home) continue;
    const parents = referenced.get(p) ?? [];
    if (parents.length !== 1) err(`page ${p.slice(0, 8)} is opened by ${parents.length} folder keys (expected 1)`);
  }
  // no stray files
  for (const n of files.keys()) {
    if (n === "package.json" || n === "Profiles/" || n.startsWith(rootDir)) continue;
    err(`unexpected entry ${n}`);
  }
  void visible;
  return errs;
}
