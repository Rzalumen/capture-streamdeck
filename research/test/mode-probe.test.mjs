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

test('mode-probe end to end on a synthetic object with two modes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modes-run-'));
  const lib = path.join(dir, 'Synth.c2z');
  fs.writeFileSync(lib, buildModeLibrary().file);
  const out = path.join(dir, 'reports');
  // Run the real script in place and tell it where to write. (v0.1 copied the script into the temp dir; the temp dir is
  // reached through a symlink on macOS, which exposed the main-module check bug fixed by lib/main.mjs.)
  const run = execFileSync(process.execPath, [path.join(ROOT, 'research', 'mode-probe.mjs'), '--lib', lib, '--out', out,
    '--fixture', MODE_FIXTURE, '--mode', MODE_A, '--name', 'Standard', '--expect', '3', '--mode', MODE_B, '--name', 'Extended', '--expect', '6'], { stdio: 'pipe', encoding: 'utf8' });
  const reportFile = path.join(out, 'modes-2f7c6351.txt');
  t.diagnostic(`temp dir ${dir} (realpath ${fs.realpathSync(dir)}); report expected at ${reportFile}; script said: ${run.trim().split('\n').pop()}`);
  assert.ok(fs.existsSync(reportFile), `mode-probe did not write ${reportFile}; it printed:\n${run}; dir listing: ${JSON.stringify(fs.readdirSync(dir))}`);
  const rep = fs.readFileSync(reportFile, 'utf8');
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

test('isMain: true for the script Node started, also when the path goes through a symlink; false for an import', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'ismain-'));
  const link = real + '-link';
  fs.symlinkSync(real, link);
  try {
    const lib = path.join(ROOT, 'research', 'lib', 'main.mjs');
    fs.writeFileSync(path.join(real, 'x.mjs'), `import { isMain } from ${JSON.stringify(lib)};\nprocess.stdout.write(String(isMain(import.meta.url)) + '\\n');\n`);
    // The child must not depend on colour settings: Node's console.log paints booleans when FORCE_COLOR is set (it printed
    // "\x1b[33mtrue\x1b[39m" on Reza's Mac). The child writes String(x), its env drops colour variables, and ANSI codes are stripped anyway.
    const env = { ...process.env, NO_COLOR: '1' }; delete env.FORCE_COLOR;
    const ansi = /\x1b\[[0-9;]*m/g;
    const runChild = (p, e = env) => execFileSync(process.execPath, [p], { encoding: 'utf8', env: e }).replace(ansi, '').trim();
    for (const p of [path.join(real, 'x.mjs'), path.join(link, 'x.mjs')]) assert.equal(runChild(p), 'true', p);
    // and with colour forced in the child's env
    assert.equal(runChild(path.join(real, 'x.mjs'), { ...process.env, FORCE_COLOR: '1' }), 'true', 'FORCE_COLOR=1');
    fs.writeFileSync(path.join(real, 'y.mjs'), `import './x.mjs';\n`);
    assert.equal(runChild(path.join(link, 'y.mjs')), 'false');
  } finally { fs.rmSync(link, { force: true }); fs.rmSync(real, { recursive: true, force: true }); }
});
