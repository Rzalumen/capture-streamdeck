import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CAEX, CitpFramer, HEADER_SIZE, buildCaexEmpty, buildFixtureIdentify, buildFixtureListRequest, buildHeader, buildPNam, decodeFixtureList, decodeMessage, isAllowedOutgoing } from '../lib/citp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'research', 'citp-connect.mjs');
const w8 = (v) => Buffer.from([v]);
const w16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const w32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const wf = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b; };
const ucs2 = (s) => Buffer.from(s + '\0', 'utf16le');
const kind = (m) => (m.toString('latin1', 16, 20) === 'PINF' ? m.toString('latin1', 20, 24) : `caex:0x${m.readUInt32LE(20).toString(16).padStart(8, '0')}`);
const hex8 = (v) => '0x' + v.toString(16).padStart(8, '0');
const FORBIDDEN = ['FixtureList', 'FixtureModify', 'FixtureRemove', 'FixtureSelection', 'FixtureConsoleStatus', 'SetFixtureTransformationSpace'].map((n) => `caex:0x${CAEX[n].toString(16).padStart(8, '0')}`);
const enterShow = (name) => Buffer.concat([buildHeader(HEADER_SIZE + 4 + (name.length + 1) * 2, 'CAEX'), w32(CAEX.EnterShow), ucs2(name)]);
const caex = (code, ...parts) => { const inner = Buffer.concat([w32(code), ...parts]); return Buffer.concat([buildHeader(HEADER_SIZE + inner.length, 'CAEX'), inner]); };

// Instance ids with deliberately non-symmetric bytes, so a byte-order mistake in the encoder cannot hide.
const guidBytes = (n) => Buffer.from([0x33, 0x22, 0x11, n, 0x55, 0x44, 0x77, 0x66, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xf0 + (n & 15)]);
const rawStr = (b) => { const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };

/** CAEX FixtureList (5.5) exactly as Capture sends it. f: {identifier, mfr, name, mode, channels, channel, instance?: Buffer, patched, universe, uc} */
function fixtureList(fixtures) {
  const body = [w8(0), w16(fixtures.length)];
  for (const f of fixtures) {
    const ids = [[0x02, Buffer.alloc(16, 2)], [0x03, Buffer.alloc(16, 3)]];
    if (f.instance) ids.push([0x04, f.instance]);
    body.push(w32(f.identifier), ucs2(f.mfr), ucs2(f.name), ucs2(f.mode), w16(f.channels), w8(0), w8(ids.length),
      ...ids.flatMap(([t, d]) => [w8(t), w16(d.length), d]),
      w8(f.patched ? 1 : 0), w8(f.universe), w16(f.uc), ucs2(''), w16(f.channel), ucs2(''), ucs2(''), wf(0), wf(0), wf(0), wf(0), wf(0), wf(0));
  }
  return caex(CAEX.FixtureList, ...body);
}
const makeFixtures = () => [
  { identifier: 0xffffffff, mfr: 'Rogue', name: 'R2X Wash', mode: 'Extended', channels: 22, channel: 203, instance: guidBytes(1), patched: false, universe: 0, uc: 0 },
  { identifier: 0xffffffff, mfr: 'Rogue', name: 'R2X Wash', mode: 'Extended', channels: 22, channel: 204, instance: guidBytes(2), patched: false, universe: 0, uc: 0 },
  { identifier: 0xffffffff, mfr: 'Martin', name: 'MAC Aura', mode: 'Basic', channels: 14, channel: 7, instance: guidBytes(3), patched: false, universe: 0, uc: 0 },
  { identifier: 0xffffffff, mfr: 'Generic', name: 'Dimmer', mode: '1ch', channels: 1, channel: 9, patched: false, universe: 0, uc: 0 }, // no CaptureInstanceId
];

/**
 * Stub Capture. behaviour.accept: apply FixtureIdentify; behaviour.fillPatch: after it, fixture 0 gets patch fields;
 * behaviour.events: after it, push FixtureSelection / FixtureModify messages (what Capture does when you click / patch).
 */
function startStub(fixtures, behaviour = {}) {
  const rec = { received: [], times: [], identifyAt: null, requests: 0, requestTimes: [] };
  const server = net.createServer((c) => {
    const framer = new CitpFramer();
    c.write(buildCaexEmpty(CAEX.GetLaserFeedList));
    c.on('data', (d) => {
      for (const m of framer.push(d).messages) {
        rec.received.push(m); rec.times.push(Date.now());
        if (m.toString('latin1', 16, 24) === 'PINFPNam') c.write(enterShow('FISH WP COPY'));
        else if (m.length === 24 && m.readUInt32LE(20) === CAEX.FixtureListRequest) { rec.requests++; rec.requestTimes.push(Date.now()); c.write(fixtureList(fixtures)); }
        else if (m.readUInt32LE(20) === CAEX.FixtureIdentify) {
          rec.identifyAt = Date.now();
          const n = m.readUInt16LE(HEADER_SIZE + 4);
          if (behaviour.accept) {
            for (let i = 0; i < n; i++) {
              const o = HEADER_SIZE + 6 + i * 20; const g = m.subarray(o, o + 16); const id = m.readUInt32LE(o + 16);
              const f = fixtures.find((x) => x.instance && x.instance.equals(g));
              if (f && !(behaviour.skipFixture === f.channel)) f.identifier = id;
            }
          }
          if (behaviour.fillPatch) { fixtures[0].patched = true; fixtures[0].universe = 0; fixtures[0].uc = 284; }
          if (behaviour.events) {
            const ids = fixtures.map((f) => f.identifier);
            setTimeout(() => c.write(caex(CAEX.FixtureSelection, w16(1), w32(ids[0]))), 400);
            setTimeout(() => c.write(caex(CAEX.FixtureSelection, w16(2), w32(ids[2]), w32(ids[1]))), 700);
            setTimeout(() => c.write(caex(CAEX.FixtureSelection, w16(1), w32(0x12345678))), 900);
            setTimeout(() => c.write(caex(CAEX.FixtureSelection, w16(1), w32(ids[0]))), 3500); // after the verification list: described from the list itself
            setTimeout(() => c.write(caex(CAEX.FixtureModify, w16(1), w32(ids[1]), w8(0x05), w8(1), w8(0), w16(306), w16(204))), 1100);
          }
        }
      }
    });
    c.on('error', () => {});
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, rec, port: server.address().port })));
}
const run = (port, dir, extra = []) => new Promise((resolve) => execFile(process.execPath, [SCRIPT, '--identify', '--host', '127.0.0.1', '--port', String(port), '--report-dir', dir, ...extra], { timeout: 60000 }, (e, so, se) => resolve({ code: e ? e.code : 0, so, se })));

test('FixtureIdentify encoding: u16 count + (16 guid bytes exactly as received, u32 identifier), header size right', () => {
  const g1 = guidBytes(1), g2 = guidBytes(2);
  const m = buildFixtureIdentify([{ guid: g1, identifier: 100001 }, { guid: g2, identifier: 100002 }]);
  assert.equal(m.length, HEADER_SIZE + 4 + 2 + 2 * 20);
  assert.equal(m.toString('latin1', 0, 4), 'CITP');
  assert.equal(m.toString('latin1', 16, 20), 'CAEX');
  assert.equal(m.readUInt32LE(8), m.length);
  assert.equal(m.readUInt32LE(20), 0x00020204);
  assert.equal(m.readUInt16LE(24), 2);
  assert.ok(m.subarray(26, 42).equals(g1) && m.readUInt32LE(42) === 100001, 'first entry: the guid bytes unchanged, then the identifier little-endian');
  assert.ok(m.subarray(46, 62).equals(g2) && m.readUInt32LE(62) === 100002);
  assert.deepEqual(m.subarray(42, 46), Buffer.from([0xa1, 0x86, 0x01, 0x00]), '100001 = 0x000186a1, little-endian');
  const d = decodeMessage(m);
  assert.deepEqual(d.identify.map((x) => [x.guidRaw, x.identifier]), [[rawStr(g1), 100001], [rawStr(g2), 100002]]);
  assert.throws(() => buildFixtureIdentify([]), RangeError);
  assert.throws(() => buildFixtureIdentify([{ guid: Buffer.alloc(15), identifier: 1 }]), RangeError);
});

test('allowlist: FixtureIdentify only with {identify: true} and only when well-formed; every other write stays refused in every phase', () => {
  const ok = buildFixtureIdentify([{ guid: guidBytes(1), identifier: 100001 }]);
  assert.equal(isAllowedOutgoing(ok), false, 'default: refused');
  assert.equal(isAllowedOutgoing(ok, { identify: true }), true);
  const bad = Buffer.from(ok); bad.writeUInt16LE(2, HEADER_SIZE + 4); // count says 2, body holds 1
  assert.equal(isAllowedOutgoing(bad, { identify: true }), false);
  const zero = Buffer.from(ok.subarray(0, HEADER_SIZE + 6)); zero.writeUInt32LE(zero.length, 8); zero.writeUInt16LE(0, HEADER_SIZE + 4);
  assert.equal(isAllowedOutgoing(zero, { identify: true }), false, 'count 0');
  const wrongSize = Buffer.from(ok); wrongSize.writeUInt32LE(ok.length + 1, 8);
  assert.equal(isAllowedOutgoing(wrongSize, { identify: true }), false, 'MessageSize disagrees with the bytes');
  for (const n of ['FixtureList', 'FixtureModify', 'FixtureRemove', 'FixtureSelection', 'FixtureConsoleStatus', 'SetFixtureTransformationSpace', 'FixtureIdentify']) {
    assert.equal(isAllowedOutgoing(buildCaexEmpty(CAEX[n]), { identify: true }), false, `${n} (no body) stays refused`);
  }
  for (const n of ['FixtureList', 'FixtureModify', 'FixtureRemove', 'FixtureSelection', 'FixtureConsoleStatus', 'SetFixtureTransformationSpace']) {
    assert.equal(isAllowedOutgoing(caex(CAEX[n], w16(1), w32(1)), { identify: true }), false, `${n} with a body stays refused`);
  }
  for (const m of [buildPNam('x'), buildFixtureListRequest()]) assert.ok(isAllowedOutgoing(m, { identify: true }) && isAllowedOutgoing(m));
});

test('citp-connect --identify: map, ONE FixtureIdentify with the exact guid bytes, verify request after 2 s, selections / modifies logged, summary block', async () => {
  const fixtures = makeFixtures();
  const stub = await startStub(fixtures, { accept: true, fillPatch: true, events: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citp-identify-'));
  try {
    const r = await run(stub.port, dir, ['--seconds', '7', '--rerequest-seconds', '3']);
    assert.equal(r.code, 0, r.so + r.se);
    const rep = fs.readFileSync(path.join(dir, 'citp-identify.txt'), 'utf8');
    if (process.env.IDENTIFY_REPORT_COPY) fs.writeFileSync(process.env.IDENTIFY_REPORT_COPY, rep); // dev only: keep the sample report
    assert.ok(rep.startsWith(`Phase: identify\nTarget: 127.0.0.1:${stub.port}\n`));

    // everything sent is allowlisted (identify allowed), the forbidden set never appears, exactly ONE FixtureIdentify
    const out = stub.rec.received;
    out.forEach((m) => assert.ok(isAllowedOutgoing(m, { identify: true }), kind(m)));
    FORBIDDEN.forEach((k) => assert.ok(!out.map(kind).includes(k), `never sent ${k}`));
    const ids = out.filter((m) => m.readUInt32LE(20) === CAEX.FixtureIdentify && m.toString('latin1', 16, 20) === 'CAEX');
    assert.equal(ids.length, 1, 'exactly one FixtureIdentify');
    const m = ids[0];
    assert.equal(m.readUInt16LE(HEADER_SIZE + 4), 3, 'three fixtures have a CaptureInstanceId (the dimmer has none)');
    // the bytes are exactly the 0x04 identifier data from the FixtureList, identifier = 100001 + list index
    [[1, 0], [2, 1], [3, 2]].forEach(([n, idx], k) => {
      const o = HEADER_SIZE + 6 + k * 20;
      assert.ok(m.subarray(o, o + 16).equals(guidBytes(n)), `guid bytes of fixture ${idx}`);
      assert.equal(m.readUInt32LE(o + 16), 100001 + idx);
    });
    assert.equal(kind(out[0]), 'PNam');
    assert.equal(kind(out[out.length - 1]), 'caex:0x00020101', 'LeaveShow last');
    // order: FixtureListRequest ... FixtureIdentify ... then the verify request ~2 s later
    const iAt = stub.rec.identifyAt;
    const after = stub.rec.requestTimes.filter((t) => t > iAt)[0];
    assert.ok(after - iAt >= 1900 && after - iAt < 3000, `verify FixtureListRequest ${after - iAt} ms after FixtureIdentify`);
    assert.ok(stub.rec.requests >= 3, `FixtureListRequests: ${stub.rec.requests}`);

    // log: the map, then the identify, then verification
    assert.match(rep, /---- ID map: identifier = 100001 \+ list index; 3 of 4 fixture\(s\) have a CaptureInstanceId ----/);
    assert.ok(rep.includes(`${rawStr(guidBytes(1))}`));
    assert.match(rep, /100001 \(0x000186a1\)/);
    assert.match(rep, /NOT identified: #3 Ch 9 Generic Dimmer: no CaptureInstanceId/);
    assert.match(rep, /SEND CAEX FixtureIdentify \(3 fixture\(s\)\)/);
    assert.match(rep, /==== AFTER FixtureIdentify \(list #2\) ====/);
    assert.match(rep, /carrying an identifier other than 0xffffffff: 3; matching our map: 3 of 3; mismatching: 0/);
    assert.match(rep, /Patched\/Universe\/UniverseChannel filled: YES \(1 fixture\(s\)\) \(first list: 0\)\n\s+Ch 203 Rogue R2X Wash: patched=1 universe=1 \[0\] address=285 \[284\]/);
    // selections (timestamp, identifiers, fixtures) and modify (all fields)
    assert.match(rep, /\+\d+\.\d\ds \d\d:\d\d:\d\d\.\d{3}Z -> FIXTURE SELECTION: 0x000186a1 \(assigned by us: Ch 203 Rogue R2X Wash\)\n/);
    assert.match(rep, /FIXTURE SELECTION: 0x000186a3 \(assigned by us: Ch 7 Martin MAC Aura\); 0x000186a2 \(assigned by us: Ch 204 Rogue R2X Wash\)/);
    assert.match(rep, /FIXTURE SELECTION: 0x12345678\n/);
    assert.match(rep, /\+3\.\d\ds [\d:.]+Z -> FIXTURE SELECTION: 0x000186a1 \(Ch 203 Rogue R2X Wash\)\n/, 'later: named from the FixtureList that now carries the identifiers');
    assert.match(rep, /FIXTURE MODIFY: 0x000186a2 \(assigned by us: Ch 204 Rogue R2X Wash\) ChangedFields=0x5; PATCH FIELDS patched=1 universe=1 \[0\] address=307 \[306\]; channel=204/);
    // periodic list shows the change in patch fields? (identifiers/patch unchanged between later lists here) - stated either way
    assert.match(rep, /no change in identifiers or patch fields since the previous list|CHANGES since the previous list/);
    // summary block
    const sum = rep.slice(rep.indexOf('== Identify summary =='));
    assert.match(sum, /fixtures in the first FixtureList: 4; with a usable CaptureInstanceId: 3; not identified: 1/);
    assert.match(sum, /FixtureIdentify sent: YES, 3 entries, identifiers 100001 \+ list index, at \+/);
    assert.match(sum, /identified count after FixtureIdentify \(list #2 at \+[\d.]+s [\d:.]+Z\): 3 of 4 fixture\(s\) carry an identifier other than 0xffffffff/);
    assert.match(sum, /match our map: 3 of 3; mismatching: 0/);
    assert.match(sum, /filled after FixtureIdentify: YES \(1 fixture\(s\)\) \(first list: 0\)/);
    assert.match(sum, /patch fields seen in any FixtureList or FixtureModify: YES/);
    assert.match(sum, /FixtureSelection events: 4\n/);
    assert.match(sum, /FixtureModify events: 1 \(items decoded: 1; with patch fields: 1\)/);
    assert.match(sum, /LeaveShow sent: yes/);
  } finally { stub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('citp-connect --identify: Capture ignores it (identifiers stay 0xffffffff) and one fixture keeps a different id -> reported plainly; later changes in patch fields are reported', async () => {
  const fixtures = makeFixtures();
  const stub = await startStub(fixtures, { accept: true, skipFixture: 204 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citp-identify-'));
  try {
    // after the verification list, the stub patches fixture 0 (a periodic list must show it)
    setTimeout(() => { fixtures[0].patched = true; fixtures[0].uc = 100; }, 3000);
    const r = await run(stub.port, dir, ['--seconds', '6.5', '--rerequest-seconds', '2', '--verify-delay', '0.5']);
    assert.equal(r.code, 0, r.so + r.se);
    const rep = fs.readFileSync(path.join(dir, 'citp-identify.txt'), 'utf8');
    const sum = rep.slice(rep.indexOf('== Identify summary =='));
    assert.match(sum, /identified count after FixtureIdentify \(list #2 .*\): 2 of 4/);
    assert.match(sum, /match our map: 2 of 3; mismatching: 1/);
    assert.match(rep, /MISMATCH Ch 204 Rogue R2X Wash: has 0xffffffff, we assigned 0x000186a2/);
    assert.match(rep, /PATCH FIELDS patched 0->1, universe 1->1, address 1->101/);
    assert.match(sum, /later lists with a change in identifiers or patch fields: [1-9]/);
    assert.match(sum, /filled after FixtureIdentify: NO \(first list: 0\)/, 'at the verification list nothing was patched yet');
    assert.match(sum, /patch fields seen in any FixtureList or FixtureModify: YES/, 'but a later list had them');
    assert.match(sum, /FixtureSelection events: 0/);
    assert.match(sum, /FixtureModify events: 0 \(items decoded: 0; with patch fields: 0\)/);
    assert.equal(stub.rec.received.filter((m) => m.readUInt32LE(20) === CAEX.FixtureIdentify && kind(m).startsWith('caex')).length, 1);
  } finally { stub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('citp-connect --identify: Capture ignores FixtureIdentify completely -> 0 identified, nothing filled, summary says NO', async () => {
  const fixtures = makeFixtures();
  const stub = await startStub(fixtures, {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citp-identify-'));
  try {
    const r = await run(stub.port, dir, ['--seconds', '3', '--rerequest-seconds', '5', '--verify-delay', '0.5']);
    assert.equal(r.code, 0, r.so + r.se);
    const sum = fs.readFileSync(path.join(dir, 'citp-identify.txt'), 'utf8').split('== Identify summary ==')[1];
    assert.match(sum, /FixtureIdentify sent: YES, 3 entries/);
    assert.match(sum, /: 0 of 4 fixture\(s\) carry an identifier other than 0xffffffff/);
    assert.match(sum, /match our map: 0 of 3; mismatching: 3/);
    assert.match(sum, /filled after FixtureIdentify: NO/);
    assert.match(sum, /patch fields seen in any FixtureList or FixtureModify: NO/);
  } finally { stub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('citp-connect --identify: no fixture with a CaptureInstanceId -> nothing is sent and the summary says why', async () => {
  const fixtures = makeFixtures().map((f) => ({ ...f, instance: undefined }));
  const stub = await startStub(fixtures, { accept: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citp-identify-'));
  try {
    const r = await run(stub.port, dir, ['--seconds', '2.5', '--rerequest-seconds', '5', '--verify-delay', '0.5']);
    assert.equal(r.code, 0, r.so + r.se);
    const rep = fs.readFileSync(path.join(dir, 'citp-identify.txt'), 'utf8');
    assert.ok(!stub.rec.received.some((m) => m.toString('latin1', 16, 20) === 'CAEX' && m.readUInt32LE(20) === CAEX.FixtureIdentify), 'no FixtureIdentify on the wire');
    assert.match(rep, /FixtureIdentify NOT sent: no fixture has a usable CaptureInstanceId/);
    assert.match(rep, /FixtureIdentify sent: NO \(no fixture has a usable CaptureInstanceId\)/);
    assert.match(rep, /identified count after FixtureIdentify: n\/a \(nothing was sent\)/);
  } finally { stub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('citp-connect --sync is unchanged: it still never sends a FixtureIdentify and its summary has no identify block', async () => {
  const fixtures = makeFixtures();
  const stub = await startStub(fixtures, { accept: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citp-identify-'));
  try {
    const r = await new Promise((resolve) => execFile(process.execPath, [SCRIPT, '--sync', '--host', '127.0.0.1', '--port', String(stub.port), '--seconds', '1.5', '--report-dir', dir], { timeout: 60000 }, (e, so, se) => resolve({ code: e ? e.code : 0, so, se })));
    assert.equal(r.code, 0, r.so + r.se);
    stub.rec.received.forEach((m) => assert.ok(isAllowedOutgoing(m), kind(m)));
    assert.ok(!stub.rec.received.some((m) => m.toString('latin1', 16, 20) === 'CAEX' && m.readUInt32LE(20) === CAEX.FixtureIdentify));
    assert.ok(!fs.readFileSync(path.join(dir, 'citp-sync.txt'), 'utf8').includes('Identify summary'));
    // FixtureList decode sanity of the stub's own builder
    assert.equal(decodeFixtureList(fixtureList(makeFixtures())).fixtures.length, 4);
  } finally { stub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
