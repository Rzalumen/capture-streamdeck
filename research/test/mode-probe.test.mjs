import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openLibrary } from '../lib/c2z.mjs';
import { DEFAULT_ROWS, guidPatterns, parseArgs } from '../mode-probe.mjs';
import { MODE_A, MODE_B, MODE_FIXTURE, buildModeLibrary, mixedEndian } from './synth-c2z.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('readObjectByGuid opens <rawGuid>.c2o directly (no Index.c2t)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modes-'));
  const f = path.join(dir, 'Synth.c2z');
  const { file, object } = buildModeLibrary();
  fs.writeFileSync(f, file);
  const lib = openLibrary(f);
  try {
    assert.ok(lib.readObjectByGuid(MODE_FIXTURE).equals(object));
    assert.ok(lib.readObjectByGuid(MODE_FIXTURE.toUpperCase()).equals(object), 'case-insensitive');
    assert.throws(() => lib.readObjectByGuid('not-a-guid'), /not a GUID/);
    assert.throws(() => lib.readObjectByGuid('00000000-0000-4000-8000-000000000000'), /not found/);
  } finally { lib.close(); }
});

test('mode-probe: argument parsing and default rows', () => {
  assert.equal(parseArgs([]).length, DEFAULT_ROWS.length);
  const a = parseArgs(['--fixture', MODE_FIXTURE, '--mode', MODE_A, '--name', 'Standard', '--expect', '14', '--mode', MODE_B]);
  assert.equal(a[0].modes.length, 2);
  assert.equal(a[0].modes[0].expect, 14);
  assert.equal(a[0].modes[1].expect, undefined);
  assert.throws(() => parseArgs(['--mode', MODE_A]), /after a --fixture/);
  assert.throws(() => parseArgs(['--fixture', 'zzz']), /raw GUID/);
  const pats = guidPatterns(MODE_B);
  assert.ok(pats[0].buf.equals(Buffer.from(MODE_B.replace(/-/g, ''), 'hex')));
  assert.ok(pats[1].buf.equals(mixedEndian(MODE_B)));
});

test('mode-probe end to end on a synthetic object with two modes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modes-run-'));
  const lib = path.join(dir, 'Synth.c2z');
  fs.writeFileSync(lib, buildModeLibrary().file);
  const work = path.join(dir, 'repo');
  fs.mkdirSync(path.join(work, 'research', 'lib'), { recursive: true });
  for (const f of ['mode-probe.mjs', 'lib/c2z.mjs']) fs.copyFileSync(path.join(ROOT, 'research', f), path.join(work, 'research', f));
  execFileSync(process.execPath, [path.join(work, 'research', 'mode-probe.mjs'), '--lib', lib,
    '--fixture', MODE_FIXTURE, '--mode', MODE_A, '--name', 'Standard', '--expect', '3', '--mode', MODE_B, '--name', 'Extended', '--expect', '6'], { stdio: 'pipe' });
  const rep = fs.readFileSync(path.join(work, 'reports', 'modes-2f7c6351.txt'), 'utf8');
  assert.match(rep, /inflated length \d+ \(PASS\)/);
  assert.match(rep, /first u32 = \d+\s+\(== size\? PASS\)/);
  // GUID A is stored in raw order, GUID B in mixed-endian order: each matches only its own encoding
  assert.match(rep, /\[raw byte order\] 1 hit\(s\)/);
  assert.match(rep, /\[mixed-endian byte order\] 1 hit\(s\)/);
  const secA = rep.split('-- mode 1:')[1].split('-- mode 2:')[0];
  assert.match(secA, /\[raw byte order\] 1 hit/); assert.match(secA, /\[mixed-endian byte order\] 0 hit/);
  const secB = rep.split('-- mode 2:')[1].split('== 3.')[0];
  assert.match(secB, /\[raw byte order\] 0 hit/); assert.match(secB, /\[mixed-endian byte order\] 1 hit/);
  // names via len = bytes + 1
  assert.match(rep, /len = bytes \+ 1: 1 hit/);
  assert.match(rep, /len = bytes:\s+0 hit/);
  // segments: 4 markers (guid, name, guid, name) -> 4 segments; the two that carry the attribute lists hold 3 and 6
  const overview = rep.split('Segment overview')[1].split('-- segment 1')[0];
  const rows = overview.split('\n').filter((l) => /^\s+\d+\s+\|/.test(l));
  assert.equal(rows.length, 4, overview);
  const attr = rows.map((r) => r.split('|').map((c) => c.trim()));
  // [seg, range, bytes, starts at, strings, attr-like, expect]
  assert.match(attr[1][3], /m1 name \(len=bytes\+1\)/);
  assert.match(attr[1][5], /^3\//, 'mode A: Pan/Tilt/Dimmer');
  assert.equal(attr[1][6], '3', 'expect printed next to the segment');
  assert.match(attr[3][3], /m2 name \(len=bytes\+1\)/);
  assert.match(attr[3][5], /^6\//, 'mode B: 6 attribute-like strings');
  assert.equal(attr[3][6], '6');
  assert.match(rep, /"Pan Fine"/);
  assert.ok(rep.indexOf('segment 2') < rep.indexOf('"Tilt Fine"'));
});
