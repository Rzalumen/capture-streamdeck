import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAllowedOutgoing } from '../lib/citp.mjs';
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

test('dmx-proof: with no --fixture it lists the patched fixtures and sends no DMX, and CITP stays on the allowlist', async () => {
  const { dir, lib } = setup();
  const stub = await startPatchStub([fixA(), fixB(), fixA({ name: 'Spinner A', universe: 3, address: 100 }), fixB({ patched: false, name: 'Unpatched C', universe: 5 })]);
  const udp = await listener();
  try {
    const r = await run([], { stub, lib, dir, udp });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Patched fixtures in show "STUB SHOW"/);
    assert.match(r.stdout, /Acme\s+\|\s+Spinner A\s+\|\s+Full\s+\|\s+8\s+\|\s+2\/10\s+\|\s+0/);
    assert.match(r.stdout, /Other Co\s+\|\s+Wash B\s+\|\s+Basic\s+\|\s+5\s+\|\s+4\/1\s+\|\s+1/); // shares universe 4 with the other Spinner A
    assert.match(r.stdout, /Spinner A\s+\|\s+Full\s+\|\s+8\s+\|\s+4\/101\s+\|\s+1/);
    assert.doesNotMatch(r.stdout, /Unpatched C/);
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
    assert.match(r.stdout, /sACN E1\.31, universe 2 = Capture's 0-based universe 1 \+ 1 \(an ASSUMPTION/);
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
    const expect = { 0: /mode block has 8 channel\(s\) but Capture's patch says ChannelCount=9/, 1: /cannot read library object/, 2: /pan and tilt not found/, 3: /did not send both identifiers/, 999: /no patched fixture with # 999/ };
    for (const [n, re] of Object.entries(expect)) {
      const r = await run(['--fixture', n, '--seconds', '0.5', '--no-multicast'], { stub, lib, dir, udp });
      assert.equal(r.code, 2, `#${n}: ${r.stdout}`);
      assert.match(r.stdout, re, `#${n}`);
      assert.match(r.stdout, /No DMX sent|no patched fixture/, `#${n}`);
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
