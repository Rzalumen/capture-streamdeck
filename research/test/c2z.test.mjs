import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lpString, lpEncode, openLibrary } from '../lib/c2z.mjs';
import { buildSyntheticLibrary, GUIDS } from './synth-c2z.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Real first bytes of Index.c2t (after its first 3 header u32s): u32 LE length = string bytes + 1, no terminator.
const VECTOR = '04000000426172' + '070000004c6164646572' + '0b000000547269616e67756c6172' +
  '08000000466f6c64696e67' + '0c00000052656374616e67756c6172';

test('Index.c2t length rule: len = bytes + 1 (test vector from the real library)', () => {
  const buf = Buffer.concat([Buffer.alloc(12), Buffer.from(VECTOR, 'hex')]);
  let pos = 12; const got = [];
  for (let i = 0; i < 5; i++) { const s = lpString(buf, pos); assert.ok(s, `string ${i} parsed`); got.push([s.len, s.str]); pos = s.end; }
  assert.deepEqual(got, [[4, 'Bar'], [7, 'Ladder'], [11, 'Triangular'], [8, 'Folding'], [12, 'Rectangular']]);
  assert.equal(pos, buf.length, 'all bytes consumed');
});

test('old rule (len = bytes) is NOT what the reader assumes; encoding matches the vector', () => {
  const oldStyle = Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.from('Bar')]); // len == bytes
  assert.equal(lpString(oldStyle, 0).str, 'Ba', 'under len = bytes + 1, an old-style len of 3 reads only 2 bytes');
  assert.equal(lpEncode('Bar').toString('hex'), '04000000426172');
});

test('synthetic library: lighting record accepted, _Symbols decoy rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2z-test-'));
  const f = path.join(dir, 'Synth.c2z');
  fs.writeFileSync(f, buildSyntheticLibrary().file);
  const lib = openLibrary(f);
  try {
    const vl = lib.findFixtureRecords('VL3500 Spot');
    assert.equal(vl.length, 1);
    assert.equal(vl[0].accepted, true);
    assert.equal(vl[0].manufacturer, 'Vari-Lite');
    assert.equal(vl[0].guidFile, GUIDS['VL3500 Spot']);
    assert.equal(vl[0].path, '_LightingFixtures\\Vari-Lite\\Moving Heads\\' + GUIDS['VL3500 Spot']);
    assert.equal(vl[0].modelTextOffset, vl[0].indexOffset + 4);

    const mac = lib.findFixtureRecords('MAC Aura XB');
    assert.equal(mac.length, 2);
    const accepted = mac.filter((h) => h.accepted), rejected = mac.filter((h) => !h.accepted);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].guidFile, GUIDS['MAC Aura XB']);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].pathFound, /^_Symbols\\/);

    assert.equal(lib.findFixtureRecords('VL3500').length, 0, 'exact match only, no substring hits');
    assert.equal(lib.allIndexRecords().length, 2);
    const e = lib.entryInfo(GUIDS['VL3500 Spot']);
    assert.equal(e.sizeOk, true);
    assert.equal(e.inflated.readUInt32LE(0), e.size);
  } finally { lib.close(); }
});

test('library-probe runs end to end on the synthetic library and prints both length interpretations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2z-probe-'));
  const lib = path.join(dir, 'Synth.c2z');
  fs.writeFileSync(lib, buildSyntheticLibrary().file);
  // the probe writes to <repo>/reports; use a copy of the tree so tests never touch a real reports/ folder
  const work = path.join(dir, 'repo');
  fs.mkdirSync(path.join(work, 'research', 'lib'), { recursive: true });
  for (const f of ['library-probe.mjs', 'lib/c2z.mjs']) fs.copyFileSync(path.join(ROOT, 'research', f), path.join(work, 'research', f));
  execFileSync(process.execPath, [path.join(work, 'research', 'library-probe.mjs'), '--lib', lib], { stdio: 'pipe' });
  const summary = fs.readFileSync(path.join(work, 'reports', 'library-summary.txt'), 'utf8');
  assert.match(summary, /Fixture "VL3500 Spot": size check PASS/);
  assert.match(summary, /Fixture "MAC Aura XB": size check PASS/);
  const rep = fs.readFileSync(path.join(work, 'reports', 'library-vl3500-spot.txt'), 'utf8');
  assert.match(rep, /\(a1\) length-prefixed, interpretation "len = string bytes"/);
  assert.match(rep, /\(a2\) length-prefixed, interpretation "len = string bytes \+ 1"/);
  assert.match(rep, /"Pan Coarse"/);
});
