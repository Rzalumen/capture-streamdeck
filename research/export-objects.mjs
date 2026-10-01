// Export Capture library objects (.c2o) so they can be studied: the inflated bytes, unchanged, one file per fixture TYPE.
//
//   node research/export-objects.mjs                  read the live patch over CITP (read-only) and export the library object of
//                                                     EVERY distinct fixture type in the open show (patched or not)
//   node research/export-objects.mjs --guid <raw>     export that object only (raw-order GUID = the .c2o file name); repeatable,
//                                                     skips CITP
// Options: --lib <path> (default Capture 2026 Library.c2z)  --out <dir> (default reports/objects)
//          --host <ip> --port <n> (CITP target, skip discovery)
// Writes <out>/<manufacturer>-<model>__<guid>.bin and <out>/manifest.txt (model, modes used in the show, guid, size, size check).
// reports/ is gitignored. The library is only read. Nothing is sent to Capture beyond the read-only CITP allowlist.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/main.mjs';
import { libPathFromArgs, openLibrary } from './lib/c2z.mjs';
import { readPatch } from './lib/citp-sync.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseArgs(argv) {
  const o = { guids: [], lib: null, out: path.join(ROOT, 'reports', 'objects'), host: null, port: null };
  const need = (i, n) => { if (argv[i + 1] === undefined) throw new Error(`${n} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--guid') { const g = need(i, a).trim().replace(/^\{|\}$/g, '').toLowerCase(); if (!GUID_RE.test(g)) throw new Error(`--guid must be 8-4-4-4-12 hex, got ${JSON.stringify(argv[i + 1])}`); o.guids.push(g); i++; }
    else if (a === '--lib') { o.lib = path.resolve(need(i, a)); i++; }
    else if (a === '--out') { o.out = path.resolve(need(i, a)); i++; }
    else if (a === '--host') { o.host = need(i, a); i++; }
    else if (a === '--port') { o.port = Number(need(i, a)); if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error('--port must be 1-65535'); i++; }
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

export const safeName = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';

/** Distinct fixture types of a decoded FixtureList, keyed by AtlaBaseFixtureId (raw order). Fixtures without one are returned apart. */
export function fixtureTypes(fixtures) {
  const byGuid = new Map(), noId = [];
  for (const f of fixtures) {
    const guid = f.ids.find((d) => d.type === 0x02)?.guidRaw;
    if (!guid) { noId.push(f); continue; }
    if (!byGuid.has(guid)) byGuid.set(guid, { guid, manufacturer: f.manufacturer, model: f.name, names: new Set(), modes: new Map(), count: 0 });
    const t = byGuid.get(guid);
    t.names.add(`${f.manufacturer} ${f.name}`);
    t.count++;
    const modeGuid = f.ids.find((d) => d.type === 0x03)?.guidRaw ?? '(no AtlaBaseModeId)';
    const m = t.modes.get(f.mode) ?? new Set();
    m.add(modeGuid); t.modes.set(f.mode, m);
  }
  return { types: [...byGuid.values()], noId };
}

async function main(opts, say) {
  let types = [], noId = [], showName = null;
  if (opts.guids.length) {
    types = opts.guids.map((guid) => ({ guid, manufacturer: '', model: '', names: new Set(), modes: new Map(), count: 0, fromArg: true }));
    say(`Exporting ${types.length} object(s) named on the command line (no CITP).`);
  } else {
    say('Reading the live patch from Capture over CITP (read-only) ...');
    const patch = await readPatch({ host: opts.host, port: opts.port, log: (s) => say(`  ${s}`) });
    if (!patch.ok) { say(`ERROR: ${patch.error}`); return 1; }
    showName = patch.showName;
    ({ types, noId } = fixtureTypes(patch.fixtures));
    say(`${patch.fixtures.length} fixture(s) in the show${showName ? ` ${JSON.stringify(showName)}` : ''}: ${types.length} distinct fixture type(s).`);
    if (noId.length) say(`${noId.length} fixture(s) carry no AtlaBaseFixtureId and cannot be exported: ${[...new Set(noId.map((f) => `${f.manufacturer} ${f.name}`))].join('; ')}`);
  }
  if (!types.length) { say('Nothing to export.'); return noId.length ? 2 : 1; }

  const libPath = opts.lib ?? libPathFromArgs([]);
  let lib;
  try { lib = openLibrary(libPath); } catch (e) { say(`ERROR: cannot open the library ${libPath}: ${e.message}`); return 2; }
  fs.mkdirSync(opts.out, { recursive: true });
  const manifest = [`Exported ${new Date().toISOString()}`, `Library: ${libPath}`, showName ? `Show: ${showName}` : 'Show: (guids given on the command line)', ''];
  let failed = 0;
  for (const t of types) {
    // names for --guid mode: look the record up in Index.c2t (best effort, listing only)
    if (t.fromArg) {
      try { const r = lib.allIndexRecords().find((x) => x.path.toLowerCase().endsWith(`${t.guid}.c2o`)); if (r) { t.manufacturer = r.manufacturer; t.model = r.model; } } catch { /* names are optional */ }
    }
    const label = `${t.manufacturer || '(unknown manufacturer)'} ${t.model || '(unknown model)'}`;
    try {
      const e = lib.entryInfo(`${t.guid}.c2o`);
      const file = `${safeName(`${t.manufacturer || 'unknown'}-${t.model || 'unknown'}`)}__${t.guid}.bin`;
      fs.writeFileSync(path.join(opts.out, file), e.inflated);
      const modes = [...t.modes.entries()].map(([n, g]) => `${JSON.stringify(n)} [${[...g].join(', ')}]`).join('; ') || '(not known)';
      const sizeCheck = e.sizeOk ? `OK (inflated ${e.inflatedLength} = tree size ${e.size})` : `MISMATCH (inflated ${e.inflatedLength}, tree size ${e.size})`;
      manifest.push(`model:      ${label}${t.count ? `   (${t.count} fixture(s) in the show)` : ''}`,
        `modes used: ${modes}`, `guid:       ${t.guid}`, `file:       ${file}`, `size:       ${e.inflatedLength} bytes`, `size check: ${sizeCheck}${e.matchCount > 1 ? `; ${e.matchCount} tree entries have this name, first one that inflates used` : ''}`, '');
      say(`  ${label}: ${e.inflatedLength} bytes -> ${file}  [size check ${e.sizeOk ? 'OK' : 'MISMATCH'}]`);
    } catch (err) {
      failed++;
      manifest.push(`model:      ${label}`, `guid:       ${t.guid}`, `NOT EXPORTED: ${err.message}`, '');
      say(`  ${label} (${t.guid}): NOT EXPORTED: ${err.message}`);
    }
  }
  lib.close();
  const mf = path.join(opts.out, 'manifest.txt');
  fs.writeFileSync(mf, manifest.join('\n') + '\n');
  say(`manifest: ${mf}`);
  say(`Exported ${types.length - failed} of ${types.length} object(s) to ${opts.out}. Upload everything in that folder (the .bin files and manifest.txt) to Claude.`);
  return failed ? 3 : 0;
}

if (isMain(import.meta.url)) {
  const say = (s = '') => console.log(s);
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`export-objects: ${e.message}`); process.exit(2); }
  let code;
  try { code = await main(opts, say); } catch (e) { console.error(`FATAL: ${e.stack}`); code = 1; }
  process.exit(code);
}
