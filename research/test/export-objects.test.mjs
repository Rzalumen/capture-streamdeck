import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAllowedOutgoing } from '../lib/citp.mjs';
import { fixtureTypes, parseArgs, safeName } from '../export-objects.mjs';
import { buildLibraryFile, buildModeBlock, buildObject, decoyTail, startPatchStub } from './synth-modes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'research', 'export-objects.mjs');
const FIX_A = '11111111-2222-4333-8444-555555555555', MODE_A1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', MODE_A2 = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
const FIX_B = '66666666-7777-4888-9999-000000000000', MODE_B = 'ffffffff-0000-4111-8222-333333333333';
const OBJ_A = buildObject(buildModeBlock({ guid: MODE_A1, channels: [{ name: 'Pan', tail: decoyTail }, { name: 'Tilt', tail: decoyTail }] }), buildModeBlock({ guid: MODE_A2, name: 'Extended', channels: [{ name: 'Dimmer' }] }));
const OBJ_B = buildObject(buildModeBlock({ guid: MODE_B, channels: [{ name: 'Intensity' }] }));

const run = (args) => new Promise((resolve) => execFile(process.execPath, [SCRIPT, ...args], { timeout: 60000 }, (e, stdout, stderr) => resolve({ code: e ? e.code : 0, stdout, stderr })));

test('export-objects: argument parsing and helpers', () => {
  assert.deepEqual(parseArgs(['--guid', FIX_A.toUpperCase(), '--guid', FIX_B]).guids, [FIX_A, FIX_B]);
  assert.throws(() => parseArgs(['--guid', 'nope']), /8-4-4-4-12/);
  assert.throws(() => parseArgs(['--wat']), /unknown option/);
  assert.equal(safeName('Vari-Lite VL3500 Spot/Wash'), 'Vari-Lite_VL3500_Spot_Wash');
  assert.equal(safeName('???'), 'unnamed');
});

test('export-objects: default mode exports every distinct fixture type in the show, unchanged, with a manifest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-objects-'));
  const lib = path.join(dir, 'Synth.c2z');
  fs.writeFileSync(lib, buildLibraryFile({ [FIX_A]: OBJ_A, [FIX_B]: OBJ_B }));
  const stub = await startPatchStub([
    { mfr: 'Acme', name: 'Spinner A', mode: 'Full', channels: 2, universe: 0, address: 0, fixtureGuid: FIX_A, modeGuid: MODE_A1 },
    { mfr: 'Acme', name: 'Spinner A', mode: 'Extended', channels: 1, universe: 0, address: 10, fixtureGuid: FIX_A, modeGuid: MODE_A2 },
    { mfr: 'Other Co', name: 'Wash/B 1', mode: 'Basic', channels: 1, universe: 1, address: 0, fixtureGuid: FIX_B, modeGuid: MODE_B, patched: false }, // unpatched still counts
    { mfr: 'NoIds', name: 'Mystery', mode: 'x', channels: 1, universe: 2, address: 0 },
  ]);
  try {
    const out = path.join(dir, 'reports', 'objects');
    const r = await run(['--host', '127.0.0.1', '--port', String(stub.port), '--lib', lib, '--out', out]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /4 fixture\(s\) in the show "STUB SHOW": 2 distinct fixture type\(s\)/);
    assert.match(r.stdout, /1 fixture\(s\) carry no AtlaBaseFixtureId .*NoIds Mystery/);
    const files = fs.readdirSync(out).sort();
    assert.deepEqual(files, [`Acme-Spinner_A__${FIX_A}.bin`, `Other_Co-Wash_B_1__${FIX_B}.bin`, 'manifest.txt'].sort());
    assert.ok(fs.readFileSync(path.join(out, `Acme-Spinner_A__${FIX_A}.bin`)).equals(OBJ_A), 'bytes unchanged');
    assert.ok(fs.readFileSync(path.join(out, `Other_Co-Wash_B_1__${FIX_B}.bin`)).equals(OBJ_B), 'bytes unchanged');
    const mf = fs.readFileSync(path.join(out, 'manifest.txt'), 'utf8');
    assert.match(mf, /model:      Acme Spinner A   \(2 fixture\(s\) in the show\)/);
    assert.match(mf, new RegExp(`modes used: "Full" \\[${MODE_A1}\\]; "Extended" \\[${MODE_A2}\\]`));
    assert.match(mf, new RegExp(`guid:       ${FIX_A}`));
    assert.match(mf, new RegExp(`size:       ${OBJ_A.length} bytes`));
    assert.match(mf, /size check: OK \(inflated \d+ = tree size \d+\)/);
    assert.match(mf, /model:      Other Co Wash\/B 1/);
    stub.received.forEach((m) => assert.ok(isAllowedOutgoing(m), 'CITP allowlist'));
    // nothing but the output folder was written
    assert.deepEqual(fs.readdirSync(dir).sort(), ['Synth.c2z', 'reports']);
  } finally { stub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('export-objects: --guid skips CITP; an object that is not in the library is reported, not hidden', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-objects-'));
  const lib = path.join(dir, 'Synth.c2z');
  fs.writeFileSync(lib, buildLibraryFile({ [FIX_A]: OBJ_A }));
  try {
    const out = path.join(dir, 'o');
    const ok = await run(['--guid', FIX_A, '--lib', lib, '--out', out]);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.ok(fs.readFileSync(path.join(out, `unknown-unknown__${FIX_A}.bin`)).equals(OBJ_A));
    const bad = await run(['--guid', FIX_B, '--lib', lib, '--out', path.join(dir, 'o2')]);
    assert.equal(bad.code, 3);
    assert.match(bad.stdout, /NOT EXPORTED: entry .* not found in tree/);
    assert.match(fs.readFileSync(path.join(dir, 'o2', 'manifest.txt'), 'utf8'), /NOT EXPORTED/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('export-objects: fixtureTypes groups by AtlaBaseFixtureId', () => {
  const mk = (guidRaw, name, mode) => ({ manufacturer: 'M', name, mode, ids: guidRaw ? [{ type: 0x02, guidRaw }] : [] });
  const { types, noId } = fixtureTypes([mk(FIX_A, 'x', 'a'), mk(FIX_A, 'x', 'b'), mk(FIX_B, 'y', 'a'), mk(null, 'z', 'a')]);
  assert.equal(types.length, 2); assert.equal(noId.length, 1);
  assert.equal(types[0].count, 2); assert.deepEqual([...types[0].modes.keys()], ['a', 'b']);
});

test('reports/ and .bin files are git-ignored', () => {
  const git = spawnSync('git', ['check-ignore', '-v', 'reports/objects/x.bin', 'reports/objects/manifest.txt', 'some/dir/y.bin'], { cwd: ROOT, encoding: 'utf8' });
  if (git.error || /not a git repository/.test(git.stderr)) return; // e.g. exported source without .git
  const ignored = git.stdout.split('\n').filter(Boolean).map((l) => l.split('\t')[1]);
  assert.deepEqual(ignored, ['reports/objects/x.bin', 'reports/objects/manifest.txt', 'some/dir/y.bin']);
});
