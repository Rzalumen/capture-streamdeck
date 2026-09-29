// Read-only probe: dump strings + hex context of fixture objects (.c2o) from Capture's Library.c2z.
// Usage: node research/library-probe.mjs [--lib <path>] [--fixture "<exact model string>"]...
// Writes reports/library-<slug>.txt per fixture and reports/library-summary.txt.
// reports/ is gitignored: it contains extracts of a licensed library. Never commit it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLibrary, libPathFromArgs, isPrintable } from './lib/c2z.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS = path.join(ROOT, 'reports');
const ATTR_RE = /pan|tilt|dimmer|intens|zoom|focus|iris|cyan|magenta|yellow|cto|color|colour|gobo|prism|frost|shutter|strobe|mode|dmx|ch/i;
const SECTION3_CAP = 1500;

const argv = process.argv.slice(2);
const fixtures = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === '--fixture' && argv[i + 1]) fixtures.push(argv[++i]);
if (!fixtures.length) fixtures.push('VL3500 Spot', 'MAC Aura XB');

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const hex = (n, w = 8) => n.toString(16).padStart(w, '0');

function hexDump(buf, from, to) {
  const start = Math.max(0, from) & ~0xf;
  const end = Math.min(buf.length, to);
  const lines = [];
  for (let o = start; o < end; o += 16) {
    const row = buf.subarray(o, Math.min(o + 16, buf.length));
    const h = [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const a = [...row].map((b) => (isPrintable(b) ? String.fromCharCode(b) : '.')).join('');
    lines.push(`  ${hex(o)}  ${h}  |${a}|`);
  }
  return lines;
}

/** (a) length-prefixed: u32 LE len 1..200 followed by len printable bytes. Offsets = start of the length field. */
function lengthPrefixed(buf) {
  const out = [];
  for (let i = 0; i + 5 <= buf.length; i++) {
    const len = buf.readUInt32LE(i);
    if (len < 1 || len > 200 || i + 4 + len > buf.length) continue;
    let ok = true;
    for (let k = 0; k < len; k++) if (!isPrintable(buf[i + 4 + k])) { ok = false; break; }
    if (ok) out.push({ kind: 'lp', off: i, start: i + 4, len, str: buf.toString('latin1', i + 4, i + 4 + len) });
  }
  return out;
}

/** (b) maximal runs of printable ASCII (>=1 char) bounded by non-printable bytes (or buffer edges). */
function rawRuns(buf) {
  const out = [];
  let s = -1;
  for (let i = 0; i <= buf.length; i++) {
    const p = i < buf.length && isPrintable(buf[i]);
    if (p && s < 0) s = i;
    if (!p && s >= 0) { out.push({ kind: 'raw', off: s, start: s, len: i - s, str: buf.toString('latin1', s, i) }); s = -1; }
  }
  return out;
}

function reportFixture(lib, query) {
  const L = [];
  const p = (s = '') => L.push(s);
  const result = { query, slug: slug(query), ok: false, note: '' };

  p(`Fixture query: ${JSON.stringify(query)}`);
  p(`Library: ${lib.libPath}`);
  p(`H (data base) = ${lib.H}`);
  p('');

  // 1. index records (exact model-string match, then verify a _LightingFixtures path precedes it)
  const hits = lib.findFixtureRecords(query);
  p('== 1. Index.c2t candidate hits (exact match of u32LE(len)+model bytes) ==');
  p('   offsets: "len field" = position of the model\'s length field; "text" = len field + 4 (position of the model text)');
  if (!hits.length) p(`  No exact occurrence of the model string ${JSON.stringify(query)} in Index.c2t.`);
  hits.forEach((h, i) => {
    p(`  [${i}] ${h.accepted ? 'ACCEPTED' : 'REJECTED'}  len-field@${h.indexOffset}  text@${h.modelTextOffset}  manufacturer=${JSON.stringify(h.manufacturer)}  model=${JSON.stringify(h.model)}`);
    if (h.accepted) p(`       path=${h.path}`);
    else p(`       reason: ${h.reason}`);
  });
  const acc = hits.filter((h) => h.accepted);
  result.hits = hits;
  if (!acc.length) {
    p(`No accepted _LightingFixtures record for ${JSON.stringify(query)} (${hits.length} candidate hit(s), all rejected or none).`);
    result.note = hits.length ? 'all candidate hits rejected' : 'model string not found in Index.c2t';
    return { text: L.join('\n') + '\n', result };
  }
  const rec = acc[0];
  p(`Using accepted hit [${hits.indexOf(rec)}] (first accepted of ${acc.length}): ${rec.path}`);
  p('');

  // 2. object
  p('== 2. Object ==');
  let info;
  try { info = lib.entryInfo(rec.guidFile); } catch (e) {
    p(`FAILED to read entry ${rec.guidFile}: ${e.message}`);
    result.note = e.message;
    return { text: L.join('\n') + '\n', result };
  }
  const buf = info.inflated;
  const firstU32 = buf.readUInt32LE(0);
  p(`  entry name           : ${rec.guidFile}` + (info.matchCount > 1 ? `  (${info.matchCount} tree matches; first that inflated was used)` : ''));
  p(`  tree offset          : ${info.offset} (absolute file position ${lib.H + info.offset})`);
  p(`  tree size            : ${info.size}`);
  p(`  inflated length      : ${info.inflatedLength}`);
  p(`  inflated == tree size: ${info.sizeOk ? 'PASS' : 'FAIL'}`);
  p(`  first u32 LE         : ${firstU32}  (== size? ${firstU32 === info.size ? 'PASS' : 'FAIL'})`);
  p(`  first 64 bytes       : ${[...buf.subarray(0, 64)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  p('');
  result.sizeOkTree = info.sizeOk;
  result.sizeOkFirstU32 = firstU32 === info.size;
  result.ok = result.sizeOkTree && result.sizeOkFirstU32;
  result.record = rec; result.info = { offset: info.offset, size: info.size, inflatedLength: info.inflatedLength, firstU32 };

  const lp = lengthPrefixed(buf);
  const raw = rawRuns(buf);

  // 3. all strings (capped at SECTION3_CAP lines total)
  p('== 3. All strings, file order, byte offsets ==');
  let used = 0, truncated = false;
  const emit = (line) => { if (used < SECTION3_CAP) { p(line); used++; } else truncated = true; };
  emit(`(a) length-prefixed strings: u32 LE len 1..200 + printable bytes  [offset = start of length field; ${lp.length} found]`);
  for (const s of lp) emit(`  ${hex(s.off)}  len=${String(s.len).padStart(3)}  ${JSON.stringify(s.str)}`);
  emit(`(b) raw printable ASCII runs (>=1 char) bounded by non-printable bytes  [${raw.length} found]`);
  for (const s of raw) emit(`  ${hex(s.off)}  len=${String(s.len).padStart(3)}  ${JSON.stringify(s.str)}`);
  if (truncated) p(`  ... TRUNCATED: section 3 capped at ${SECTION3_CAP} lines. Sections 4 and 5 use the full lists.`);
  p('');

  // merged unique strings (same start + same text counted once)
  const uniq = new Map();
  for (const s of [...lp, ...raw]) {
    const k = `${s.start}:${s.str}`;
    if (!uniq.has(k)) uniq.set(k, s);
  }
  const merged = [...uniq.values()].sort((x, y) => x.start - y.start);

  // 4. hex context for attribute-like strings
  const attrHits = merged.filter((s) => ATTR_RE.test(s.str));
  p(`== 4. Hex context (48 bytes before, 64 after) for strings matching ${ATTR_RE} — ${attrHits.length} hits ==`);
  for (const s of attrHits) {
    p('');
    p(`-- ${JSON.stringify(s.str)}  string starts at 0x${hex(s.start)} (${s.start})  [${s.kind === 'lp' ? 'length-prefixed, len field at ' + s.off : 'raw run'}]`);
    hexDump(buf, s.start - 48, s.start + s.len + 64).forEach((l) => p(l));
  }
  p('');

  // 5. repetition
  p('== 5. Repetition check (distinct strings of >=2 chars; all offsets = string start) ==');
  p('   Listed: every string that occurs more than once, then single-occurrence strings matching the attribute regex.');
  const by = new Map();
  for (const s of merged) {
    if (s.len < 2) continue;
    if (!by.has(s.str)) by.set(s.str, []);
    by.get(s.str).push(s.start);
  }
  const rep = [...by].filter(([, o]) => o.length > 1).sort((a, b) => b[1].length - a[1].length || a[1][0] - b[1][0]);
  const single = [...by].filter(([str, o]) => o.length === 1 && ATTR_RE.test(str)).sort((a, b) => a[1][0] - b[1][0]);
  p(`  -- repeated (${rep.length}) --`);
  for (const [str, o] of rep) p(`  x${o.length}  ${JSON.stringify(str)}  @ ${o.map((v) => '0x' + v.toString(16)).join(', ')}`);
  p(`  -- single occurrence, attribute-like (${single.length}) --`);
  for (const [str, o] of single) p(`  x1  ${JSON.stringify(str)}  @ 0x${o[0].toString(16)}`);
  p('');

  return { text: L.join('\n') + '\n', result };
}

// ---- main ----
fs.mkdirSync(REPORTS, { recursive: true });
const libPath = libPathFromArgs(argv);
let lib;
try { lib = openLibrary(libPath); } catch (e) {
  console.error(`Cannot open library ${libPath}: ${e.message}`);
  fs.writeFileSync(path.join(REPORTS, 'library-summary.txt'), `Cannot open library ${libPath}\n${e.stack}\n`);
  process.exit(1);
}

const S = [];
S.push(`Library: ${lib.libPath} (${lib.fileSize} bytes)`);
S.push(`H (data base): ${lib.H}`);
S.push(`Tree size (inflated): ${lib.treeSize} bytes, magic ${JSON.stringify(lib.tree.subarray(0, 4).toString('latin1'))}`);
lib.log.forEach((l) => S.push(`  note: ${l}`));
try {
  const ix = lib.entryInfo('Index.c2t');
  S.push(`Index.c2t: offset ${ix.offset}, size ${ix.size}, inflated ${ix.inflatedLength}, size check ${ix.sizeOk ? 'PASS' : 'FAIL'}`);
  S.push(`Index.c2t _LightingFixtures records: ${lib.allIndexRecords().length}`);
} catch (e) { S.push(`Index.c2t: FAILED ${e.message}`); }
S.push('');

let allPass = true;
const results = [];
for (const q of fixtures) {
  let out;
  try { out = reportFixture(lib, q); } catch (e) {
    out = { text: `Probe crashed for ${q}: ${e.stack}\n`, result: { query: q, slug: slug(q), ok: false, note: e.message } };
  }
  const file = path.join(REPORTS, `library-${out.result.slug}.txt`);
  fs.writeFileSync(file, out.text);
  const r = out.result;
  results.push(r);
  allPass = allPass && r.ok;
  S.push(`Fixture ${JSON.stringify(q)}: size check ${r.ok ? 'PASS' : 'FAIL'}` +
    (r.info ? ` (tree size ${r.info.size}, inflated ${r.info.inflatedLength}, first u32 ${r.info.firstU32})` : '') +
    (r.note ? ` — ${r.note}` : ''));
  if (r.record) S.push(`  record: ${r.record.manufacturer} / ${r.record.model}  ${r.record.path}`);
  S.push(`  report: ${file}`);
}
S.push('');
// ---- self-check against ground truth verified earlier on Reza's real library ----
const GROUND_TRUTH = {
  'VL3500 Spot': { modelOffset: 125630818, path: '_LightingFixtures\\Vari-Lite\\Moving Heads\\bcc93361-fc2a-4e06-8ddf-65ca480a84e7.c2o', treeOffset: 760644065, treeSize: 20785 },
  'MAC Aura XB': { modelOffset: 85498405, path: '_LightingFixtures\\Martin\\Moving Heads\\2f7c6351-e151-4c44-beca-80bb03902631.c2o', treeOffset: 674244450, treeSize: 118160 },
};
S.push('== Self-check vs ground truth (Handoff 02 table) ==');
S.push('   model-string offset convention: the table value is compared with the position of the model TEXT; if it equals the position of the length field instead, that is reported explicitly.');
for (const [model, gt] of Object.entries(GROUND_TRUTH)) {
  const r = results.find((x) => x.query === model);
  S.push(`Fixture ${JSON.stringify(model)}:`);
  if (!r) { S.push('  (not probed in this run)'); continue; }
  const rec = r.record;
  const cmp = (label, got, want) => S.push(`  ${label.padEnd(20)} ${got === want ? 'MATCH   ' : 'MISMATCH'} got=${JSON.stringify(got)} expected=${JSON.stringify(want)}`);
  if (!rec) { S.push(`  no accepted record -> MISMATCH on all fields (${r.note || 'n/a'})`); continue; }
  cmp('path', rec.path, gt.path);
  cmp('guidFile', rec.guidFile, gt.path.slice(gt.path.lastIndexOf('\\') + 1));
  cmp('tree offset', r.info ? r.info.offset : null, gt.treeOffset);
  cmp('tree size', r.info ? r.info.size : null, gt.treeSize);
  if (rec.modelTextOffset === gt.modelOffset) S.push(`  ${'model-string offset'.padEnd(20)} MATCH    (text position ${rec.modelTextOffset}; length field at ${rec.indexOffset})`);
  else if (rec.indexOffset === gt.modelOffset) S.push(`  ${'model-string offset'.padEnd(20)} MATCH    (table value equals the LENGTH-FIELD position ${rec.indexOffset}; text at ${rec.modelTextOffset})`);
  else S.push(`  ${'model-string offset'.padEnd(20)} MISMATCH got text@${rec.modelTextOffset} len-field@${rec.indexOffset} expected=${gt.modelOffset}`);
  const acc = (r.hits || []).filter((h) => h.accepted).length;
  S.push(`  candidate hits: ${(r.hits || []).length} total, ${acc} accepted, ${(r.hits || []).length - acc} rejected`);
}
S.push('');
S.push(`Overall: ${allPass ? 'all fixtures PASS' : 'at least one fixture FAILED'}`);
const summary = path.join(REPORTS, 'library-summary.txt');
fs.writeFileSync(summary, S.join('\n') + '\n');
lib.close();
console.log(S.join('\n'));
console.log(`\nsummary: ${summary}`);
