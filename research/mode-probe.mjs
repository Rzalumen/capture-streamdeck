// Read-only exploration: where do a fixture's DMX-mode channel lists sit inside its library object (.c2o)?
//
//   node research/mode-probe.mjs                       runs the three built-in test rows (MAC Aura XB, Artiste Picasso x2)
//   node research/mode-probe.mjs --fixture <rawGuid> --mode <rawGuid> [--name <text>] [--expect <n>] [--mode ...] [--fixture ...]
//   --lib <path>   override Library.c2z
//   --out <dir>    write the reports here instead of <repo>/reports
//
// GUIDs are RAW order: the 16 bytes as Capture sends them in FixtureList, formatted 8-4-4-4-12. That is also how
// the library names fixture objects ("<rawGuid>.c2o"). --name / --expect apply to the most recent --mode.
// Report per fixture: reports/modes-<first 8 of fixture guid>.txt. Exploration only: nothing is asserted.
// reports/ holds library extracts: never commit it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLibrary, libPathFromArgs, isPrintable } from './lib/c2z.mjs';
import { isMain } from './lib/main.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS = path.join(ROOT, 'reports');
const ATTR_RE = /dimmer|intens|pan|tilt|zoom|focus|iris|cyan|magenta|yellow|cto|colou?r|gobo|prism|frost|shutter|strobe|red|green|blue|white|amber|lime|uv|speed|control|reset|mode|fx|effect/i;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_HITS_SHOWN = 200;

export const DEFAULT_ROWS = [
  { guid: '2f7c6351-e151-4c44-beca-80bb03902631', label: 'Martin MAC Aura XB',
    modes: [{ guid: '9d6629e3-872b-4a74-a935-6675826f4313', name: 'Standard', expect: 14 }] },
  { guid: '1ea4edad-e7a8-49a0-af88-ba6d059fb1fd', label: 'Elation Artiste Picasso',
    modes: [
      { guid: '84dafbd3-e9b8-445b-b6f7-e66e095b5046', name: 'Standard 1.1.7', expect: 36 },
      { guid: '0691aaec-1491-40a2-b5c3-8942bb4d2402', name: 'Extended 1.1.7', expect: 62 },
    ] },
];

export function parseArgs(argv) {
  const fixtures = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--lib' || a === '--out') { i++; continue; }
    if (a === '--fixture') { fixtures.push({ guid: String(v).toLowerCase(), label: '', modes: [] }); i++; }
    else if (a === '--mode') {
      if (!fixtures.length) throw new Error('--mode must come after a --fixture');
      fixtures[fixtures.length - 1].modes.push({ guid: String(v).toLowerCase() }); i++;
    } else if (a === '--name' || a === '--expect') {
      const f = fixtures[fixtures.length - 1], m = f && f.modes[f.modes.length - 1];
      if (!m) throw new Error(`${a} must follow a --mode`);
      if (a === '--name') m.name = v; else m.expect = Number(v);
      i++;
    } else throw new Error(`unknown argument ${a}`);
  }
  for (const f of fixtures) {
    if (!GUID_RE.test(f.guid)) throw new Error(`fixture is not a raw GUID (8-4-4-4-12 hex): ${f.guid}`);
    for (const m of f.modes) if (!GUID_RE.test(m.guid)) throw new Error(`mode is not a raw GUID (8-4-4-4-12 hex): ${m.guid}`);
  }
  return fixtures.length ? fixtures : structuredClone(DEFAULT_ROWS);
}

const hex = (n, w = 8) => n.toString(16).padStart(w, '0');
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };

/** All start offsets of `needle` in `buf`. */
export function findAll(buf, needle) {
  const r = []; let from = 0;
  for (;;) { const at = buf.indexOf(needle, from); if (at < 0) break; r.push(at); from = at + 1; }
  return r;
}

/** GUID search patterns for a raw-order GUID string. */
export function guidPatterns(rawGuid) {
  const raw = Buffer.from(rawGuid.replace(/-/g, ''), 'hex');
  const mixed = Buffer.from(raw);
  mixed.subarray(0, 4).reverse(); mixed.subarray(4, 6).reverse(); mixed.subarray(6, 8).reverse();
  const pats = [{ label: 'raw byte order', buf: raw }];
  if (!mixed.equals(raw)) pats.push({ label: 'mixed-endian byte order', buf: mixed });
  pats.push({ label: 'ASCII text (lowercase)', buf: Buffer.from(rawGuid, 'latin1') });
  pats.push({ label: 'UTF-16LE text (lowercase)', buf: Buffer.from(rawGuid, 'utf16le') });
  return pats;
}

function dump(buf, from, to, indent = '    ') {
  const start = Math.max(0, from) & ~0xf, end = Math.min(buf.length, to);
  const lines = [];
  for (let o = start; o < end; o += 16) {
    const row = buf.subarray(o, Math.min(o + 16, buf.length));
    const h = [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const a = [...row].map((b) => (isPrintable(b) ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${indent}${hex(o)}  ${h}  |${a}|`);
  }
  return lines;
}

/** Printable run containing offset `at` (for raw-text hits: is the name a whole string or inside a longer one?). */
function runAround(buf, at, len) {
  let s = at, e = at + len;
  while (s > 0 && isPrintable(buf[s - 1])) s--;
  while (e < buf.length && isPrintable(buf[e])) e++;
  return { s, e, whole: s === at && e === at + len, text: buf.toString('latin1', s, Math.min(e, s + 80)) };
}

/** Length-prefixed ASCII strings whose length field starts in [from, to), under both conventions. */
export function lpStringsIn(buf, from, to) {
  const out = [];
  for (let i = from; i < to && i + 5 <= buf.length; i++) {
    const len = buf.readUInt32LE(i);
    for (const delta of [1, 0]) {
      const n = len - delta;
      if (n < 1 || n > 200 || i + 4 + n > buf.length) continue;
      let ok = true;
      for (let k = 0; k < n; k++) if (!isPrintable(buf[i + 4 + k])) { ok = false; break; }
      if (ok) out.push({ off: i, conv: delta ? 'len=bytes+1' : 'len=bytes', lenField: len, n, str: buf.toString('latin1', i + 4, i + 4 + n) });
    }
  }
  return out;
}

export function probeFixture(lib, fx) {
  const L = [];
  const p = (s = '') => L.push(s);
  const summary = { guid: fx.guid, ok: false, modes: [] };
  p(`Fixture ${fx.label ? fx.label + ' ' : ''}${fx.guid}   (raw-order GUID = library entry "${fx.guid}.c2o")`);
  p(`Library: ${lib.libPath}   H=${lib.H}`);
  p('');

  // ---- 1. object ----
  p('== 1. Object ==');
  let info, buf;
  try { info = lib.entryInfo(`${fx.guid}.c2o`); buf = info.inflated; } catch (e) {
    p(`  FAILED to read ${fx.guid}.c2o: ${e.message}`);
    summary.note = e.message;
    return { text: L.join('\n') + '\n', summary };
  }
  const first = buf.readUInt32LE(0);
  p(`  tree offset ${info.offset}, tree size ${info.size}, inflated length ${info.inflatedLength} (${info.sizeOk ? 'PASS' : 'FAIL'})`);
  p(`  first u32 = ${first}  (== size? ${first === info.size ? 'PASS' : 'FAIL'})`);
  summary.ok = info.sizeOk && first === info.size; summary.size = info.size;
  p('');

  const markers = [];
  const addMarker = (m) => markers.push(m);

  // ---- 2. mode GUID hits ----
  p('== 2. Mode GUID hits (each with 256 bytes before and 512 bytes after) ==');
  fx.modes.forEach((m, mi) => {
    p('');
    p(`-- mode ${mi + 1}: ${m.guid}${m.name ? `  name=${JSON.stringify(m.name)}` : ''}${m.expect != null ? `  expect=${m.expect}` : ''}`);
    let total = 0;
    for (const pat of guidPatterns(m.guid)) {
      const hits = findAll(buf, pat.buf);
      p(`  [${pat.label}] ${hits.length} hit(s)${hits.length ? ' at ' + hits.map((h) => '0x' + h.toString(16)).join(', ') : ''}`);
      total += hits.length;
      hits.slice(0, MAX_HITS_SHOWN).forEach((h) => {
        p(`    hit @ ${h} (0x${h.toString(16)}), ${pat.label}:`);
        dump(buf, h - 256, h + pat.buf.length + 512, '      ').forEach((l) => p(l));
        addMarker({ off: h, kind: `guid (${pat.label})`, mode: mi });
      });
    }
    summary.modes.push({ guid: m.guid, guidHits: total });
    if (!total) p('  (no occurrence of this mode GUID in any encoding)');
  });
  p('');

  // ---- 3. mode name hits ----
  p('== 3. Mode name hits ==');
  fx.modes.forEach((m, mi) => {
    if (!m.name) return;
    p('');
    p(`-- mode ${mi + 1} name ${JSON.stringify(m.name)}`);
    const nb = Buffer.from(m.name, 'latin1');
    const lp1 = findAll(buf, Buffer.concat([u32(nb.length + 1), nb]));
    const lp0 = findAll(buf, Buffer.concat([u32(nb.length), nb]));
    const lpCovered = new Set([...lp1, ...lp0].map((o) => o + 4));
    p(`  length-prefixed, len = bytes + 1: ${lp1.length} hit(s)${lp1.length ? ' (length field at ' + lp1.map((h) => '0x' + h.toString(16)).join(', ') + ')' : ''}`);
    p(`  length-prefixed, len = bytes:     ${lp0.length} hit(s)${lp0.length ? ' (length field at ' + lp0.map((h) => '0x' + h.toString(16)).join(', ') + ')' : ''}`);
    lp1.forEach((h) => addMarker({ off: h, kind: 'name (len=bytes+1)', mode: mi }));
    lp0.forEach((h) => addMarker({ off: h, kind: 'name (len=bytes)', mode: mi }));
    const raw = findAll(buf, nb);
    p(`  raw text: ${raw.length} hit(s) (text offsets)`);
    raw.slice(0, MAX_HITS_SHOWN).forEach((h) => {
      const run = runAround(buf, h, nb.length);
      p(`    @ ${h} (0x${h.toString(16)})  ${run.whole ? 'standalone string' : `inside a longer printable run "${run.text}"`}${lpCovered.has(h) ? '  [same as a length-prefixed hit above]' : ''}`);
      if (run.whole && !lpCovered.has(h)) addMarker({ off: h, kind: 'name (raw text, standalone)', mode: mi });
    });
    const u16 = findAll(buf, Buffer.from(m.name, 'utf16le'));
    p(`  UTF-16LE text: ${u16.length} hit(s)${u16.length ? ' at ' + u16.map((h) => '0x' + h.toString(16)).join(', ') : ''}`);
    u16.forEach((h) => addMarker({ off: h, kind: 'name (UTF-16LE)', mode: mi }));
    const s = summary.modes[mi]; s.nameHits = { lp1: lp1.length, lp0: lp0.length, raw: raw.length, utf16: u16.length };
  });
  p('');

  // ---- 4. segmenting ----
  markers.sort((a, b) => a.off - b.off || a.mode - b.mode);
  p('== 4. Segments (mode marker -> next mode marker, or end of object) ==');
  p(`   attribute-like = string matches ${ATTR_RE}`);
  p('   Markers, sorted by offset:');
  if (!markers.length) p('     (none)');
  markers.forEach((m) => p(`     @ ${m.off} (0x${m.off.toString(16)})  mode ${m.mode + 1}  ${m.kind}`));
  p('');
  // segments start at distinct marker offsets
  const starts = [...new Map(markers.map((m) => [m.off, m])).values()];
  const segs = starts.map((m, i) => ({
    start: m.off, end: i + 1 < starts.length ? starts[i + 1].off : buf.length,
    markers: markers.filter((x) => x.off === m.off), mode: m.mode,
  }));
  const table = [];
  segs.forEach((sg, idx) => {
    const strs = lpStringsIn(buf, sg.start, sg.end);
    const attr = strs.filter((x) => ATTR_RE.test(x.str));
    const uniqStart = (arr) => new Set(arr.map((x) => x.off)).size;
    const md = fx.modes[sg.mode];
    sg.strs = strs; sg.attr = attr;
    table.push([idx + 1, `${sg.start}..${sg.end}`, sg.end - sg.start, sg.markers.map((x) => `m${x.mode + 1} ${x.kind}`).join('; '),
      `${strs.length}`, `${attr.filter((x) => x.conv === 'len=bytes+1').length}/${attr.filter((x) => x.conv === 'len=bytes').length}/${uniqStart(attr)}`, md && md.expect != null ? md.expect : '-']);
  });
  p('   Segment overview (attribute-like counts are len=bytes+1 / len=bytes / distinct string offsets; expect = --expect of the mode that starts the segment):');
  const head = ['seg', 'range', 'bytes', 'starts at', 'strings', 'attr-like', 'expect'];
  const w = head.map((h, i) => Math.max(h.length, ...table.map((r) => String(r[i]).length)));
  const fmt = (r) => '   ' + r.map((v, i) => String(v).padEnd(w[i])).join(' | ');
  p(fmt(head)); p('   ' + w.map((n) => '-'.repeat(n)).join('-+-')); table.forEach((r) => p(fmt(r)));
  p('');
  segs.forEach((sg, idx) => {
    const md = fx.modes[sg.mode];
    p(`-- segment ${idx + 1}: bytes ${sg.start}..${sg.end} (${sg.end - sg.start} bytes), starts at ${sg.markers.map((x) => `mode ${x.mode + 1} ${x.kind}`).join('; ')}`);
    p(`   expect (mode ${sg.mode + 1}${md && md.name ? ` ${JSON.stringify(md.name)}` : ''}): ${md && md.expect != null ? md.expect : '(not given)'}    attribute-like strings: ${sg.attr.length}  (of ${sg.strs.length} length-prefixed strings)`);
    if (!sg.strs.length) p('   (no length-prefixed ASCII strings)');
    sg.strs.forEach((x) => p(`   ${hex(x.off)}  ${x.conv.padEnd(11)}  len-field=${String(x.lenField).padStart(3)}  ${ATTR_RE.test(x.str) ? '*' : ' '} ${JSON.stringify(x.str)}`));
    p('');
  });
  p('   (* = attribute-like)');
  return { text: L.join('\n') + '\n', summary };
}

// ---------- main ----------
if (isMain(import.meta.url)) {
  let fixtures;
  try { fixtures = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const libPath = libPathFromArgs(process.argv.slice(2));
  let lib;
  try { lib = openLibrary(libPath); } catch (e) { console.error(`Cannot open library ${libPath}: ${e.message}`); process.exit(1); }
  const oi = process.argv.indexOf('--out');
  const outDir = oi >= 0 && process.argv[oi + 1] ? path.resolve(process.argv[oi + 1]) : REPORTS;
  fs.mkdirSync(outDir, { recursive: true });
  for (const fx of fixtures) {
    let out;
    try { out = probeFixture(lib, fx); } catch (e) { out = { text: `mode-probe crashed for ${fx.guid}: ${e.stack}\n`, summary: { guid: fx.guid, note: e.message } }; }
    const file = path.join(outDir, `modes-${fx.guid.slice(0, 8)}.txt`);
    fs.writeFileSync(file, out.text);
    console.log(`${fx.guid}: size check ${out.summary.ok ? 'PASS' : 'FAIL'}${out.summary.note ? ' — ' + out.summary.note : ''}`);
    (out.summary.modes || []).forEach((m) => console.log(`  mode ${m.guid}: guid hits ${m.guidHits}${m.nameHits ? `, name hits lp+1=${m.nameHits.lp1} lp=${m.nameHits.lp0} raw=${m.nameHits.raw} utf16=${m.nameHits.utf16}` : ''}`));
    console.log(`  report: ${file}`);
  }
  lib.close();
}
