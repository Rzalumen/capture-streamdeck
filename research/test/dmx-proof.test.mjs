import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAllowedOutgoing } from '../lib/citp.mjs';
import { lpEncode } from '../lib/c2z.mjs';
import { parseDataPacket } from '../lib/sacn.mjs';
import { buildTimeline } from '../lib/dmx-seq.mjs';
import { buildLibraryFile, buildModeBlock, buildObject, decoyTail, startPatchStub } from './synth-modes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'research', 'dmx-proof.mjs');

// Two DIFFERENT synthetic fixture types (different channel counts, order and names) to show nothing is tied to a type.
const FIX_A = '11111111-2222-4333-8444-555555555555', MODE_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const FIX_B = '66666666-7777-4888-9999-000000000000', MODE_B = 'ffffffff-0000-4111-8222-333333333333';
const FIX_C = '12121212-3434-4565-8787-989898989898', MODE_C = '01010101-0202-4303-8404-050505050505';
const A_CH = [
  { name: 'Pan Coarse', role: 1, pair: 1 }, { name: 'Pan Fine', role: 2, pair: 0 }, { name: 'Tilt Coarse', role: 1, pair: 3 }, { name: 'Tilt Fine', role: 2, pair: 2 },
  { name: 'Beam Dimmer' }, { name: 'Strobe' }, { name: 'Color Wheel' }, { name: 'Gobo Wheel' },
].map((c) => ({ ...c, tail: decoyTail }));
const B_CH = [{ name: 'Intensity' }, { name: 'Zoom' }, { name: 'TILT' }, { name: 'PAN' }, { name: 'Shutter' }].map((c) => ({ ...c, tail: decoyTail }));
const C_CH = [{ name: 'Dimmer' }, { name: 'Color' }].map((c) => ({ ...c, tail: decoyTail })); // no pan / tilt

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmx-proof-'));
  const lib = path.join(dir, 'Synth.c2z');
  fs.writeFileSync(lib, buildLibraryFile({
    [FIX_A]: buildObject(buildModeBlock({ guid: MODE_A, channels: A_CH })),
    [FIX_B]: buildObject(buildModeBlock({ guid: MODE_B, channels: B_CH })),
    [FIX_C]: buildObject(buildModeBlock({ guid: MODE_C, channels: C_CH })),
  }));
  return { dir, lib };
}
const fixA = (o = {}) => ({ mfr: 'Acme', name: 'Spinner A', mode: 'Full', channels: 8, universe: 1, address: 9, fixtureGuid: FIX_A, modeGuid: MODE_A, ...o });
const fixB = (o = {}) => ({ mfr: 'Other Co', name: 'Wash B', mode: 'Basic', channels: 5, universe: 3, address: 0, fixtureGuid: FIX_B, modeGuid: MODE_B, ...o });

function listener() {
  const sock = dgram.createSocket('udp4');
  const got = [];
  sock.on('message', (m) => got.push({ t: process.hrtime.bigint(), m }));
  return new Promise((res) => sock.bind(0, '127.0.0.1', () => res({ sock, got, port: sock.address().port })));
}

function run(args, { stub, lib, dir, udp }) {
  const full = ['--host', '127.0.0.1', '--port', String(stub.port), '--lib', lib, '--report-dir', path.join(dir, 'reports'), ...(udp ? ['--sacn-port', String(udp.port)] : []), ...args];
  return new Promise((resolve) => execFile(process.execPath, [SCRIPT, ...full], { timeout: 60000 }, (e, stdout, stderr) => resolve({ code: e ? e.code : 0, stdout, stderr })));
}
const cleanup = (dir, ...things) => { things.forEach((t) => { try { t.sock?.close(); t.server?.close(); } catch { /* ignore */ } }); fs.rmSync(dir, { recursive: true, force: true }); };
const decode = (got) => got.map((g) => ({ ...parseDataPacket(g.m), t: g.t }));

test('dmx-proof: with no --fixture it lists ALL fixtures with the CAEX patch fields, sends no DMX, and CITP stays on the allowlist', async () => {
  const { dir, lib } = setup();
  const stub = await startPatchStub([fixA(), fixB(), fixA({ name: 'Spinner A', universe: 3, address: 100 }), fixB({ patched: false, name: 'Unpatched C', universe: 5 })]);
  const udp = await listener();
  try {
    const r = await run([], { stub, lib, dir, udp });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /All fixtures in show "STUB SHOW" \(4\)/);
    assert.match(r.stdout, /from CAEX: patched/);
    const row = (name) => r.stdout.split('\n').find((l) => l.includes(name));
    // # | manufacturer | model | mode | ch | Channel | patched | universe/address | others
    assert.match(row('Spinner A  ') ?? '', /^\s*0\s+\| Acme\s+\| Spinner A\s+\| Full\s+\| 8\s+\| 1\s+\| yes\s+\| 2\/10\s+\| 0\s*$/);
    assert.match(row('Wash B') ?? '', /^\s*1\s+\| Other Co\s+\| Wash B\s+\| Basic\s+\| 5\s+\| 2\s+\| yes\s+\| 4\/1\s+\| 1\s*$/); // shares universe 4 with the other Spinner A
    assert.match(row('Unpatched C') ?? '', /^\s*3\s+\| Other Co\s+\| Unpatched C\s+\| Basic\s+\| 5\s+\| 4\s+\| no\s+\| - \(raw u5 a0\)\s+\| -\s*$/);
    assert.match(r.stdout, /probe:dmx -- --fixture/);
    await new Promise((s) => setTimeout(s, 150));
    assert.equal(udp.got.length, 0, 'no DMX in list mode');
    stub.received.forEach((m) => assert.ok(isAllowedOutgoing(m), 'only allowlisted CITP messages'));
    assert.ok(fs.existsSync(path.join(dir, 'reports', 'dmx-proof.txt')));
  } finally { cleanup(dir, udp, stub); }
});

test('dmx-proof: end to end on fixture type A - table, packets at 40 fps, values from the parsed channels, termination', async () => {
  const { dir, lib } = setup();
  const stub = await startPatchStub([fixA(), fixB()]);
  const udp = await listener();
  try {
    const r = await run(['--fixture', '0', '--seconds', '0.6', '--no-multicast', '--shutter-value', '200'], { stub, lib, dir, udp });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    // printed channel table: offset, DMX address, name, role, pair
    assert.match(r.stdout, /0\s+\|\s+10\s+\|\s+Pan Coarse\s+\|\s+coarse\s+\|\s+1/);
    assert.match(r.stdout, /3\s+\|\s+13\s+\|\s+Tilt Fine\s+\|\s+fine\s+\|\s+2/);
    assert.match(r.stdout, /5\s+\|\s+15\s+\|\s+Strobe\s+\|\s+8-bit\s+\|\s+-/);
    assert.match(r.stdout, /8 channels = block channelCount = Capture's ChannelCount/);
    assert.match(r.stdout, /pan\s+offset 0 "Pan Coarse" \+ fine offset 1 "Pan Fine" \(16-bit\)/);
    assert.match(r.stdout, /intensity\s+offset 4 "Beam Dimmer" \(8-bit\)/);
    assert.match(r.stdout, /shutter\s+offset 5 "Strobe" \(8-bit\)/);
    assert.match(r.stdout, /sACN E1\.31, universe 2 = the CAEX universe \(0-based 1\) \+ 1 \(an ASSUMPTION/);
    assert.match(r.stdout, /terminated: \d+ data frames/);

    await new Promise((s) => setTimeout(s, 200));
    const pk = decode(udp.got);
    const live = pk.filter((p) => !p.terminated), term = pk.filter((p) => p.terminated);
    const total = buildTimeline({ holdSeconds: 1, sweepSeconds: 0.6 }).total;
    assert.equal(term.length, 3, 'three Stream_Terminated frames');
    assert.deepEqual(pk.slice(-3).map((p) => p.terminated), [true, true, true], 'terminated frames are last');
    assert.ok(live.length >= Math.floor(total * 40) - 2 && live.length <= Math.ceil(total * 40) + 3, `frame count ${live.length} for ${total} s at 40 fps`);
    const gaps = live.slice(1).map((p, i) => Number(p.t - live[i].t) / 1e6).sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    assert.ok(median > 20 && median < 30, `median frame gap ${median.toFixed(1)} ms`);
    pk.forEach((p, i) => {
      assert.equal(p.universe, 2); assert.equal(p.priority, 100); assert.equal(p.sourceName, 'capture-streamdeck dmx-proof');
      assert.equal(p.startCode, 0); assert.ok(p.cid.equals(pk[0].cid), 'CID constant');
      if (i) assert.equal(p.sequence, (pk[i - 1].sequence + 1) & 255, 'sequence increments');
    });

    // slot values: fixture A is patched at 0-based address 9; offsets come from the table printed above
    const base = 9;
    const first = live[0].slots;
    assert.equal(first[base + 4], 255, 'intensity 100%');
    assert.equal(first[base + 5], 200, 'shutter raw value from --shutter-value');
    assert.equal(first[base + 0], 0x80); assert.equal(first[base + 1], 0x00, 'pan 50% = 0x8000');
    assert.equal(first[base + 2], 0x80); assert.equal(first[base + 3], 0x00, 'tilt 50% = 0x8000');
    for (const p of pk) for (let s = 0; s < 512; s++) if (s < base || s >= base + 6) assert.equal(p.slots[s], 0, `slot ${s + 1} must stay 0`);
    const panOf = (p) => p.slots[base] * 256 + p.slots[base + 1], tiltOf = (p) => p.slots[base + 2] * 256 + p.slots[base + 3];
    const pans = live.map(panOf), tilts = live.map(tiltOf);
    assert.equal(Math.min(...pans), 0); assert.ok(Math.max(...pans) >= 65535 - 1900, `pan max ${Math.max(...pans)}`);
    assert.equal(Math.min(...tilts), 0); assert.ok(Math.max(...tilts) >= 65535 - 1900);
    // pan moves while tilt is centred, then the other way round
    const iPanMax = pans.indexOf(Math.max(...pans)), iTiltMax = tilts.indexOf(Math.max(...tilts));
    assert.ok(iPanMax < iTiltMax, 'pan sweeps before tilt');
    assert.ok(tilts.slice(0, iPanMax).every((v) => v === 32768), 'tilt stays at 50% while pan moves');
    assert.ok(pans.slice(iTiltMax - 5, iTiltMax).every((v) => v === 32768), 'pan stays at 50% while tilt moves');
    // fine byte really carries the low byte (some frame has a non-zero fine byte)
    assert.ok(live.some((p) => p.slots[base + 1] !== 0));
    live.forEach((p) => assert.equal(p.slots[base + 4], 255));
    stub.received.forEach((m) => assert.ok(isAllowedOutgoing(m)));
  } finally { cleanup(dir, udp, stub); }
});

test('dmx-proof: a different fixture type (other order/names/8-bit pan) is handled by the same code', async () => {
  const { dir, lib } = setup();
  const stub = await startPatchStub([fixA(), fixB()]);
  const udp = await listener();
  try {
    const r = await run(['--fixture', '1', '--seconds', '0.5', '--no-multicast'], { stub, lib, dir, udp });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /pan\s+offset 3 "PAN" \(8-bit\)/);
    assert.match(r.stdout, /tilt\s+offset 2 "TILT" \(8-bit\)/);
    assert.match(r.stdout, /default; a GUESS/);
    await new Promise((s) => setTimeout(s, 200));
    const live = decode(udp.got).filter((p) => !p.terminated);
    assert.ok(live.length > 60);
    assert.equal(live[0].universe, 4);
    assert.deepEqual([live[0].slots[0], live[0].slots[1], live[0].slots[2], live[0].slots[3], live[0].slots[4]], [255, 0, 128, 128, 255], 'intensity, zoom=0, tilt 50%, pan 50%, shutter default 255');
    // 8-bit pan: frames fall between phase boundaries, so allow a few steps of slack at both ends
    assert.ok(Math.max(...live.map((p) => p.slots[3])) >= 245); assert.ok(Math.min(...live.map((p) => p.slots[3])) <= 15);
  } finally { cleanup(dir, udp, stub); }
});

test('dmx-proof: refuses when other patched fixtures share the universe, unless --force', async () => {
  const { dir, lib } = setup();
  const stub = await startPatchStub([fixA(), fixB({ universe: 1, address: 100, name: 'Neighbour' })]);
  const udp = await listener();
  try {
    const r = await run(['--fixture', '0', '--seconds', '0.5', '--no-multicast'], { stub, lib, dir, udp });
    assert.equal(r.code, 2, r.stdout);
    assert.match(r.stdout, /WARNING: 1 other patched fixture\(s\) share universe 2: #1 Other Co Neighbour @101/);
    assert.match(r.stdout, /Refusing to send/);
    await new Promise((s) => setTimeout(s, 200));
    assert.equal(udp.got.length, 0, 'nothing sent');
    const f = await run(['--fixture', '0', '--seconds', '0.5', '--no-multicast', '--force'], { stub, lib, dir, udp });
    assert.equal(f.code, 0, f.stdout);
    assert.match(f.stdout, /--force given/);
    await new Promise((s) => setTimeout(s, 200));
    assert.ok(decode(udp.got).filter((p) => !p.terminated).length > 60, 'frames sent with --force');
  } finally { cleanup(dir, udp, stub); }
});

test('dmx-proof: aborts without DMX on a channel-count mismatch, a missing object, missing pan/tilt, or an unknown #', async () => {
  const { dir, lib } = setup();
  const stub = await startPatchStub([
    fixA({ channels: 9 }),                                                    // #0: Capture says 9, the mode block has 8
    { mfr: 'Ghost', name: 'No Object', mode: 'x', channels: 4, universe: 0, address: 0, fixtureGuid: '99999999-9999-4999-8999-999999999999', modeGuid: MODE_A }, // #1
    { mfr: 'Plain', name: 'Dimmer Only', mode: 'x', channels: 2, universe: 6, address: 0, fixtureGuid: FIX_C, modeGuid: MODE_C }, // #2
    { mfr: 'NoIds', name: 'No Identifiers', mode: 'x', channels: 2, universe: 7, address: 0 },                                       // #3
  ]);
  const udp = await listener();
  try {
    const expect = { 0: /mode block has 8 channel\(s\) but Capture's patch says ChannelCount=9/, 1: /cannot read library object/, 2: /pan and tilt not found/, 3: /did not send both identifiers/, 999: /no fixture with # 999/ };
    for (const [n, re] of Object.entries(expect)) {
      const r = await run(['--fixture', n, '--seconds', '0.5', '--no-multicast'], { stub, lib, dir, udp });
      assert.equal(r.code, 2, `#${n}: ${r.stdout}`);
      assert.match(r.stdout, re, `#${n}`);
      assert.match(r.stdout, /No DMX sent|no fixture with/, `#${n}`);
    }
    await new Promise((s) => setTimeout(s, 200));
    assert.equal(udp.got.length, 0, 'no packet in any aborted run');
  } finally { cleanup(dir, udp, stub); }
});

test('dmx-proof: multicast destinations on every local interface are logged and sent to; Ctrl-C still sends 3 terminate frames', async () => {
  const { dir, lib } = setup();
  const stub = await startPatchStub([fixA()]);
  const udp = await listener();
  try {
    const args = [SCRIPT, '--host', '127.0.0.1', '--port', String(stub.port), '--lib', lib, '--report-dir', path.join(dir, 'reports'), '--sacn-port', String(udp.port), '--fixture', '0', '--seconds', '30'];
    const child = spawn(process.execPath, args);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    await new Promise((res, rej) => { const t0 = Date.now(); const t = setInterval(() => { if (/sending \.\.\./.test(out)) { clearInterval(t); res(); } else if (Date.now() - t0 > 15000) { clearInterval(t); child.kill(); rej(new Error('never started sending:\n' + out)); } }, 20); });
    await new Promise((s) => setTimeout(s, 700));
    child.kill('SIGINT');
    const code = await new Promise((res) => child.on('close', res));
    assert.equal(code, 0, out);
    assert.match(out, /destination: unicast 127\.0\.0\.1 -> 127\.0\.0\.1:/);
    const ifs = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' || i.family === 4);
    for (const i of ifs) assert.match(out, new RegExp(`destination: multicast 239\\.255\\.0\\.2 via \\S+ \\(${i.address.replace(/\./g, '\\.')}\\) -> 239\\.255\\.0\\.2:${udp.port}`));
    assert.match(out, /stopped early by Ctrl-C/);
    assert.match(out, /Frames handed to the network per destination:/);
    await new Promise((s) => setTimeout(s, 200));
    const pk = decode(udp.got);
    assert.ok(pk.length >= 25, `got ${pk.length}`);
    assert.deepEqual(pk.slice(-3).map((p) => p.terminated), [true, true, true]);
    assert.equal(pk.filter((p) => p.terminated).length, 3);
  } finally { cleanup(dir, udp, stub); }
});


// ---- Handoff 12: Capture sends NO patch over CAEX (Patched=0, universe 0, address 0) ----
const noPatch = (o = {}) => fixA({ patched: false, universe: 0, address: 0, ...o });

test('dmx-proof: a fixture without CAEX patch and without --universe/--address is refused, nothing is sent; the list still shows it', async () => {
  const { dir, lib } = setup();
  const stub = await startPatchStub([noPatch(), noPatch({ name: 'Spinner 2' })]);
  const udp = await listener();
  try {
    const list = await run([], { stub, lib, dir, udp });
    assert.equal(list.code, 0, list.stdout);
    assert.match(list.stdout, /Acme\s+\| Spinner A\s+\| Full\s+\| 8\s+\| 1\s+\| no\s+\| - \(raw u0 a0\)/);
    assert.match(list.stdout, /No fixture has a patch in the CAEX data/);
    assert.match(list.stdout, /--universe <1\.\.> --address <1\.\.512>/);
    const r = await run(['--fixture', '0', '--no-multicast'], { stub, lib, dir, udp });
    assert.equal(r.code, 2, r.stdout);
    assert.match(r.stdout, /Capture sent no patch for this fixture over CAEX \(Patched=0\)/);
    assert.match(r.stdout, /--fixture 0 --universe <1\.\.> --address <1\.\.512>/);
    await new Promise((s) => setTimeout(s, 200));
    assert.equal(udp.got.length, 0, 'nothing sent');
  } finally { cleanup(dir, udp, stub); }
});

test('dmx-proof: --universe/--address override the (empty) CAEX patch: sends to that sACN universe and those slots, prints the manual address and the warning', async () => {
  const { dir, lib } = setup();
  const stub = await startPatchStub([noPatch(), noPatch({ name: 'Spinner 2' })]);
  const udp = await listener();
  try {
    const r = await run(['--fixture', '0', '--universe', '3', '--address', '285', '--seconds', '0.5', '--no-multicast'], { stub, lib, dir, udp });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /USING A MANUAL ADDRESS: universe 3 address 285 \(from --universe\/--address\); there is no usable CAEX patch for this fixture/);
    assert.match(r.stdout, /WARNING: manual address\. Capture's CAEX data carries no patch for 1 of the other 1 fixture\(s\)/);
    assert.match(r.stdout, /holds ONLY this test fixture/);
    assert.match(r.stdout, /0\s+\| 285\s+\| Pan Coarse/);          // DMX addr column uses the manual address
    assert.match(r.stdout, /7\s+\| 292\s+\| Gobo Wheel/);
    assert.match(r.stdout, /sACN E1\.31, universe 3 = the --universe you gave/);
    await new Promise((s) => setTimeout(s, 200));
    const pk = decode(udp.got);
    const live = pk.filter((p) => !p.terminated);
    assert.ok(live.length > 60);
    pk.forEach((p) => assert.equal(p.universe, 3, 'sACN universe = --universe'));
    const base = 284; // address 285, 0-based slot
    assert.equal(live[0].slots[base + 4], 255, 'dimmer at offset 4 -> slot 289');
    assert.equal(live[0].slots[base + 0], 0x80); assert.equal(live[0].slots[base + 1], 0x00);
    for (const p of pk) for (let k = 0; k < 512; k++) if (k < base || k >= base + 6) assert.equal(p.slots[k], 0, `slot ${k + 1} must stay 0`);
    assert.deepEqual(pk.slice(-3).map((p) => p.terminated), [true, true, true]);
    stub.received.forEach((m) => assert.ok(isAllowedOutgoing(m)));
  } finally { cleanup(dir, udp, stub); }
});

test('dmx-proof: the manual address also overrides a real CAEX patch; --sacn-universe still wins for the sACN number', async () => {
  const { dir, lib } = setup();
  const stub = await startPatchStub([fixA()]); // CAEX: universe 2 address 10
  const udp = await listener();
  try {
    const r = await run(['--fixture', '0', '--universe', '5', '--address', '1', '--sacn-universe', '9', '--seconds', '0.5', '--no-multicast'], { stub, lib, dir, udp });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /this overrides the CAEX patch 2\/10/);
    assert.match(r.stdout, /universe 9 \(from --sacn-universe\)/);
    await new Promise((s) => setTimeout(s, 200));
    const live = decode(udp.got).filter((p) => !p.terminated);
    assert.equal(live[0].universe, 9);
    assert.equal(live[0].slots[4], 255, 'address 1 + offset 4');
    assert.equal(live[0].slots[9 + 4], 0, 'the CAEX address was not used');
  } finally { cleanup(dir, udp, stub); }
});

test('dmx-proof: manual address checks: both options required, range, fit in 512, CAEX-patched neighbours on that universe', async () => {
  const { dir, lib } = setup();
  const stub = await startPatchStub([noPatch(), fixB({ universe: 2, address: 50, name: 'Neighbour' })]); // #1 is CAEX-patched at universe 3 / 51
  const udp = await listener();
  try {
    const only = await run(['--fixture', '0', '--universe', '1'], { stub, lib, dir, udp });
    assert.equal(only.code, 2);
    assert.match(only.stderr, /--universe and --address go together/);
    const bad = await run(['--fixture', '0', '--universe', '1', '--address', '513'], { stub, lib, dir, udp });
    assert.equal(bad.code, 2); assert.match(bad.stderr, /--address must be a number from 1 to 512/);
    const noFix = await run(['--universe', '1', '--address', '1'], { stub, lib, dir, udp });
    assert.equal(noFix.code, 2); assert.match(noFix.stderr, /need --fixture/);
    const fit = await run(['--fixture', '0', '--universe', '1', '--address', '510', '--no-multicast'], { stub, lib, dir, udp });
    assert.equal(fit.code, 2, fit.stdout); assert.match(fit.stdout, /do not fit in 512 slots/);
    const clash = await run(['--fixture', '0', '--universe', '3', '--address', '1', '--no-multicast', '--seconds', '0.5'], { stub, lib, dir, udp });
    assert.equal(clash.code, 2, clash.stdout);
    assert.match(clash.stdout, /WARNING: 1 other patched fixture\(s\) share universe 3: #1 Other Co Neighbour @51/);
    assert.match(clash.stdout, /Refusing to send/);
    await new Promise((s) => setTimeout(s, 200));
    assert.equal(udp.got.length, 0, 'nothing sent in any refused run');
    const forced = await run(['--fixture', '0', '--universe', '3', '--address', '1', '--no-multicast', '--seconds', '0.5', '--force'], { stub, lib, dir, udp });
    assert.equal(forced.code, 0, forced.stdout);
    await new Promise((s) => setTimeout(s, 200));
    assert.ok(decode(udp.got).length > 60);
  } finally { cleanup(dir, udp, stub); }
});

// ---- Handoff 13: ambiguity that does not touch the driven channels ----
const asRec = (name) => Buffer.concat([lpEncode(name), Buffer.from([0, 0xff, 0xff])]);
const FIX_D = 'd0d0d0d0-1111-4222-8333-444444444444', MODE_D = 'd1d1d1d1-2222-4333-8444-555555555555';
const FIX_E = 'e0e0e0e0-1111-4222-8333-444444444444', MODE_E = 'e1e1e1e1-2222-4333-8444-555555555555';
const D_CH = [
  { name: 'Pan', role: 1, pair: 1 }, { name: 'Pan Fine', role: 2, pair: 0 }, { name: 'Tilt', role: 1, pair: 3 }, { name: 'Tilt Fine', role: 2, pair: 2 },
  { name: 'Pan/Tilt Speed' }, { name: 'Dimmer' }, { name: 'Dimmer Fine' }, { name: 'Shutter' }, { name: 'Red 1' }, { name: 'Zoom' },
].map((c) => ({ ...c, tail: decoyTail })).concat([{ name: 'Control', tail: Buffer.concat([Buffer.from([9, 9]), asRec('Pan/Tilt Speed'), Buffer.alloc(6, 0xcc)]) }]);
const E_CH = [{ name: 'Tilt', tail: decoyTail }, { name: 'Dimmer', tail: decoyTail }, { name: 'Shutter', tail: decoyTail },
  { name: 'Control', tail: Buffer.concat([Buffer.from([5]), asRec('Pan'), Buffer.alloc(4, 0xcc)]) }]; // "Pan" or nothing: the driven pan differs

test('dmx-proof: two candidate channel lists that differ only at an undriven offset -> proceeds, prints the NOTE, never drives the differing slot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmx-proof-'));
  const lib = path.join(dir, 'Synth.c2z');
  fs.writeFileSync(lib, buildLibraryFile({
    [FIX_D]: buildObject(buildModeBlock({ guid: MODE_D, channels: D_CH })),
    [FIX_E]: buildObject(buildModeBlock({ guid: MODE_E, channels: E_CH })),
  }));
  const fixD = { mfr: 'Acme', name: 'Rogue-like', mode: '11 Channel', channels: 11, universe: 0, address: 0, patched: false, fixtureGuid: FIX_D, modeGuid: MODE_D };
  const fixE = { mfr: 'Acme', name: 'Pan-unsure', mode: '4 Channel', channels: 4, universe: 0, address: 0, patched: false, fixtureGuid: FIX_E, modeGuid: MODE_E };
  const stub = await startPatchStub([fixD, fixE]);
  const udp = await listener();
  try {
    const r = await run(['--fixture', '0', '--universe', '1', '--address', '285', '--seconds', '0.6', '--no-multicast', '--shutter-value', '200'], { stub, lib, dir, udp });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /NOTE: 2 candidate channel lists differ only at offsets \[10\] \(not used by this test\): 10: "Control" vs "Pan\/Tilt Speed"/);
    assert.match(r.stdout, /10\s+\|\s+295\s+\|\s+Control\s+\|\s+8-bit/); // the table is the first candidate (file order)
    assert.match(r.stdout, /pan\s+offset 0 "Pan" \+ fine offset 1 "Pan Fine" \(16-bit\)/);
    assert.match(r.stdout, /intensity\s+offset 5 "Dimmer"/);
    assert.match(r.stdout, /shutter\s+offset 7 "Shutter"/);
    await new Promise((s) => setTimeout(s, 200));
    const pk = decode(udp.got);
    assert.ok(pk.length > 20, 'DMX was sent');
    const base = 284; // address 285, 0-based slot
    const first = pk.find((p) => !p.terminated).slots;
    assert.equal(first[base + 5], 255, 'dimmer 100%'); assert.equal(first[base + 7], 200, 'shutter raw');
    assert.equal(first[base + 0], 0x80); assert.equal(first[base + 2], 0x80);
    // only the driven slots (offsets 0-3, 5, 7) are ever non-zero; the differing offset 10 and every other slot stay 0
    const driven = new Set([0, 1, 2, 3, 5, 7].map((o) => base + o));
    for (const p of pk) for (let s = 0; s < 512; s++) if (!driven.has(s)) assert.equal(p.slots[s], 0, `slot ${s + 1} must stay 0`);
    stub.received.forEach((m) => assert.ok(isAllowedOutgoing(m)));

    // candidates that differ on the pan channel -> refuse, no DMX
    const udp2 = await listener();
    try {
      const bad = await run(['--fixture', '1', '--universe', '1', '--address', '1', '--seconds', '0.5', '--no-multicast'], { stub, lib, dir, udp: udp2 });
      assert.notEqual(bad.code, 0);
      assert.match(bad.stdout + bad.stderr, /could not establish this fixture's channels safely/);
      assert.match(bad.stdout + bad.stderr, /disagree on a channel that would be driven: pan: not found vs offset 3 "Pan"/);
      await new Promise((s) => setTimeout(s, 150));
      assert.equal(udp2.got.length, 0, 'no DMX when the candidates disagree on pan');
    } finally { udp2.sock.close(); }
  } finally { cleanup(dir, udp, stub); }
});

// ---- Handoff 14: --set and --color-full ----
const FIX_F = 'f0f0f0f0-1111-4222-8333-444444444444', MODE_F = 'f1f1f1f1-2222-4333-8444-555555555555';
const F_CH = [
  { name: 'Pan', role: 1, pair: 1 }, { name: 'Pan Fine', role: 2, pair: 0 }, { name: 'Tilt', role: 1, pair: 3 }, { name: 'Tilt Fine', role: 2, pair: 2 },
  { name: 'Dimmer' }, { name: 'Shutter' }, { name: 'Red 1', role: 1, pair: 7 }, { name: 'Red 1 Fine', role: 2, pair: 6 }, { name: 'Green 1' }, { name: 'Blue 1' },
  { name: 'White 1' }, { name: 'Cyan' }, { name: 'Magenta' }, { name: 'CTO' },
].map((c) => ({ ...c, tail: decoyTail }));

test('dmx-proof --color-full / --set: plan lists them, the right slots (1-based channels, fine partners) are held, cyan/magenta/CTO and everything else stay 0, bad uses are refused with no DMX', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmx-proof-'));
  const lib = path.join(dir, 'Synth.c2z');
  fs.writeFileSync(lib, buildLibraryFile({ [FIX_F]: buildObject(buildModeBlock({ guid: MODE_F, channels: F_CH })) }));
  const fixF = { mfr: 'Acme', name: 'RGBW wash', mode: '14 Channel', channels: 14, universe: 0, address: 0, patched: false, fixtureGuid: FIX_F, modeGuid: MODE_F };
  const stub = await startPatchStub([fixF]);
  const base = 9; // --address 10
  const manual = ['--fixture', '0', '--universe', '1', '--address', '10', '--seconds', '0.5', '--no-multicast'];
  const driven = [0, 1, 2, 3, 4, 5].map((o) => base + o);
  const slotsOf = async (extraArgs) => {
    const udp = await listener();
    try {
      const r = await run([...manual, ...extraArgs], { stub, lib, dir, udp });
      await new Promise((s) => setTimeout(s, 200));
      return { r, pk: decode(udp.got) };
    } finally { udp.sock.close(); }
  };
  try {
    // --color-full
    const a = await slotsOf(['--color-full']);
    assert.equal(a.r.code, 0, a.r.stdout + a.r.stderr);
    assert.match(a.r.stdout, /Extra channels held at a fixed value for the whole run \(5\):/);
    for (const [name, ch, off, v] of [['Red 1', 7, 6, 255], ['Red 1 Fine', 8, 7, 255], ['Green 1', 9, 8, 255], ['Blue 1', 10, 9, 255], ['White 1', 11, 10, 255]]) {
      assert.match(a.r.stdout, new RegExp(`${ch}\\s+\\|\\s+${off}\\s+\\|\\s+${base + off + 1}\\s+\\|\\s+${name}\\s+\\|\\s+${v}\\s+\\|\\s+--color-full`), name);
    }
    assert.doesNotMatch(a.r.stdout.split('Extra channels')[1].split('sACN E1.31')[0], /Cyan|Magenta|CTO/);
    assert.match(a.r.stdout, /except the extra channels listed above/);
    assert.ok(a.pk.length > 20);
    for (const p of a.pk) {
      for (const o of [6, 7, 8, 9, 10]) assert.equal(p.slots[base + o], 255, `offset ${o}`);
      for (let s = 0; s < 512; s++) if (!driven.includes(s) && ![6, 7, 8, 9, 10].some((o) => base + o === s)) assert.equal(p.slots[s], 0, `slot ${s + 1} must stay 0`);
    }
    assert.equal(a.pk.find((p) => !p.terminated).slots[base + 4], 255, 'dimmer is still driven');

    // --set: 1-based channel numbers; coarse brings its fine partner
    const b = await slotsOf(['--set', '11=128', '--set', '7=64', '--set', '12=0']);
    assert.equal(b.r.code, 0, b.r.stdout + b.r.stderr);
    assert.match(b.r.stdout, /Extra channels held at a fixed value for the whole run \(4\):/);
    assert.match(b.r.stdout, /7\s+\|\s+6\s+\|\s+16\s+\|\s+Red 1\s+\|\s+64\s+\|\s+--set/);
    assert.match(b.r.stdout, /8\s+\|\s+7\s+\|\s+17\s+\|\s+Red 1 Fine\s+\|\s+64\s+\|\s+--set 7 \(fine partner\)/);
    assert.match(b.r.stdout, /11\s+\|\s+10\s+\|\s+20\s+\|\s+White 1\s+\|\s+128\s+\|\s+--set/);
    for (const p of b.pk) {
      assert.deepEqual([p.slots[base + 6], p.slots[base + 7], p.slots[base + 10]], [64, 64, 128]);
      for (let s = 0; s < 512; s++) if (!driven.includes(s) && ![6, 7, 10].some((o) => base + o === s)) assert.equal(p.slots[s], 0);
    }

    // without either option nothing extra is printed or sent
    const c = await slotsOf([]);
    assert.doesNotMatch(c.r.stdout, /Extra channels/);
    assert.equal(c.pk[0].slots[base + 6], 0);

    // refusals: no DMX
    for (const [args, re] of [[['--set', '1=5'], /driven by the test itself as pan/], [['--set', '15=1'], /channels 1\.\.14/], [['--set', '5=1'], /intensity/]]) {
      const x = await slotsOf(args);
      assert.notEqual(x.r.code, 0); assert.match(x.r.stdout, re); assert.match(x.r.stdout, /No DMX sent/); assert.equal(x.pk.length, 0);
    }
    const bad = await slotsOf(['--set', '5']);
    assert.equal(bad.r.code, 2); assert.match(bad.r.stdout + bad.r.stderr, /--set needs <channel>=<value>/);
    assert.match((await slotsOf(['--set', '5=300'])).r.stderr, /--set value must be from 0 to 255/);
    stub.received.forEach((m) => assert.ok(isAllowedOutgoing(m)));
  } finally { cleanup(dir, stub); }
});

test('dmx-proof --pap: each live level frame is followed by a 0xDD frame (same CID, universe, sequence counted together): 100 on the fixture, 0 elsewhere; termination is level frames only', async () => {
  const { dir, lib } = setup();
  const stub = await startPatchStub([noPatch(), noPatch({ name: 'Spinner 2' })]);
  const udp = await listener();
  try {
    const r = await run(['--fixture', '0', '--universe', '1', '--address', '285', '--color-full', '--pap', '--seconds', '0.5', '--no-multicast'], { stub, lib, dir, udp });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /--pap: every level frame \(START code 0x00\) is followed by a per-address-priority frame \(START code 0xDD/);
    assert.match(r.stdout, /priority 100 on slots 285\.\.292 \(this fixture\), 0 = "ignore my level" on all other 504 slots/);
    assert.match(r.stdout, /etclabs\.github\.io\/sACNDocs/);
    assert.match(r.stdout, /per-address priority \(0xDD\): \d+ frames sent/);
    await new Promise((s) => setTimeout(s, 200));
    const pk = decode(udp.got);
    const lv = pk.filter((p) => p.startCode === 0x00);
    const dd = pk.filter((p) => p.startCode === 0xdd);
    assert.ok(lv.length > 60 && dd.length > 60);
    const liveLv = lv.filter((p) => !p.terminated);
    assert.equal(dd.length, liveLv.length, 'one 0xDD frame per live level frame');
    assert.ok(dd.every((p) => !p.terminated), 'no termination on the 0xDD frames');
    assert.deepEqual(lv.slice(-3).map((p) => p.terminated), [true, true, true]);
    for (let i = 0; i < pk.length - 3; i += 2) {
      assert.equal(pk[i].startCode, 0x00, `frame ${i} is levels`);
      assert.equal(pk[i + 1].startCode, 0xdd, `frame ${i + 1} is priorities`);
      assert.equal(pk[i + 1].sequence, (pk[i].sequence + 1) & 0xff, 'one sequence counter for both');
    }
    for (const p of pk) { assert.ok(p.cid.equals(pk[0].cid)); assert.equal(p.universe, 1); assert.equal(p.priority, 100); }
    for (const p of dd) for (let k = 0; k < 512; k++) assert.equal(p.slots[k], k >= 284 && k < 292 ? 100 : 0, `0xDD slot ${k + 1}`);
    stub.received.forEach((m) => assert.ok(isAllowedOutgoing(m)));
  } finally { cleanup(dir, udp, stub); }
});
