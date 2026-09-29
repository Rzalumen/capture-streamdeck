import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CAEX, CitpFramer, HEADER_SIZE, buildCaexEmpty, buildEnterShow, buildFixtureListRequest, buildHeader, buildLaserFeedList,
  buildLeaveShow, buildNack, buildPLoc, buildPNam, decodeFixtureList, decodeMessage, formatFixtureTables, guidRawStr, guidStr, hexOf,
  isAllowedOutgoing,
} from '../lib/citp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ucs2 = (s) => Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.from([0, 0])]);
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b; };

// Test-only builder for a CAEX FixtureList laid out as in CAEX spec F (as summarised; see lib/citp.mjs).
const GUID_BYTES = Buffer.from('33221100554477668899aabbccddeeff', 'hex'); // 00112233-4455-6677-8899-aabbccddeeff
const DEFAULT_IDS = [[0x05, u16(0x1234)], [0x02, GUID_BYTES]];
export function buildFixtureList(fixtures) {
  const body = [Buffer.from([0]), u16(fixtures.length)];
  for (const f of fixtures) {
    body.push(u32(f.id ?? 0xffffffff), ucs2(f.mfr), ucs2(f.name), ucs2(f.mode), u16(f.channels), Buffer.from([0]),
      Buffer.from([(f.ids || DEFAULT_IDS).length]),
      ...(f.ids || DEFAULT_IDS).flatMap(([t, d]) => [Buffer.from([t]), u16(d.length), d]),
      Buffer.from([1, f.universe]), u16(f.address), ucs2('U' + f.channel), u16(f.channel), ucs2(''), ucs2('note'),
      f32(1), f32(2), f32(3), f32(0), f32(0), f32(0));
  }
  const inner = Buffer.concat([u32(CAEX.FixtureList), ...body]);
  return Buffer.concat([buildHeader(HEADER_SIZE + inner.length, 'CAEX'), inner]);
}
const FIXTURES = [
  { mfr: 'Vari-Lite', name: 'VL3500 Spot', mode: 'Mode 1', channels: 32, universe: 0, address: 0, channel: 1 },
  { mfr: 'Martin', name: 'MAC Aura XB', mode: 'Extended', channels: 22, universe: 1, address: 100, channel: 2 },
  { mfr: 'ETC', name: 'Source Four 750W', mode: 'Dimmer', channels: 1, universe: 0, address: 300, channel: 3 },
];

test('framer: two messages in one TCP chunk', () => {
  const a = buildPNam('one'), b = buildCaexEmpty(CAEX.EnterShow);
  const f = new CitpFramer();
  const r = f.push(Buffer.concat([a, b]));
  assert.equal(r.messages.length, 2);
  assert.ok(r.messages[0].equals(a) && r.messages[1].equals(b));
  assert.equal(f.pending, 0);
});

test('framer: one message split across chunks (mid-cookie, mid-header, mid-body)', () => {
  const m = buildFixtureList(FIXTURES);
  for (const cuts of [[2], [10], [19], [20], [23], [50, 120], [1, 3, 5, 19, 21, 60]]) {
    const f = new CitpFramer(); const got = [];
    let prev = 0;
    for (const c of [...cuts, m.length]) { got.push(...f.push(m.subarray(prev, c)).messages); prev = c; }
    assert.equal(got.length, 1, `cuts ${cuts}`);
    assert.ok(got[0].equals(m), `cuts ${cuts}`);
  }
});

test('framer: split message followed by a whole one in the same chunk, byte-at-a-time too', () => {
  const a = buildFixtureList(FIXTURES), b = buildPNam('x');
  const f = new CitpFramer(); const got = [];
  got.push(...f.push(a.subarray(0, 30)).messages);
  got.push(...f.push(Buffer.concat([a.subarray(30), b])).messages);
  assert.equal(got.length, 2);
  const g = new CitpFramer(); const got2 = [];
  const all = Buffer.concat([a, b, a]);
  for (const byte of all) got2.push(...g.push(Buffer.from([byte])).messages);
  assert.equal(got2.length, 3);
});

test('framer: resyncs after garbage', () => {
  const f = new CitpFramer();
  const r = f.push(Buffer.concat([Buffer.from('zz'), buildPNam('ok')]));
  assert.equal(r.messages.length, 1);
  assert.equal(r.events.length, 1);
});

test('decoders: PLoc/PNam round trip and FixtureList (first fixtures)', () => {
  const ploc = decodeMessage(buildPLoc(56075, 'Visualizer', 'Capture', 'Running'));
  assert.deepEqual(ploc.ploc, { port: 56075, type: 'Visualizer', name: 'Capture', state: 'Running' });
  const nam = decodeMessage(buildPNam('capture-streamdeck probe'));
  assert.ok(nam.lines.join('\n').includes('capture-streamdeck probe'));
  const fl = decodeFixtureList(buildFixtureList(FIXTURES));
  assert.equal(fl.count, 3);
  assert.equal(fl.error, null);
  assert.equal(fl.fixtures[1].manufacturer, 'Martin');
  assert.equal(fl.fixtures[1].name, 'MAC Aura XB');
  assert.equal(fl.fixtures[1].mode, 'Extended');
  assert.equal(fl.fixtures[1].channelCount, 22);
  assert.equal(fl.fixtures[1].universe, 1);
  assert.equal(fl.fixtures[1].universeChannel, 100);
  assert.equal(fl.fixtures[0].ids[1].guid, '00112233-4455-6677-8899-aabbccddeeff');
  assert.equal(fl.fixtures[0].ids[0].value, '4660'); // 0x1234, decimal string
  // truncated list: reports where it stopped instead of throwing
  const cut = buildFixtureList(FIXTURES).subarray(0, 120);
  const t = decodeFixtureList(cut);
  assert.ok(t.error);
});

// ---- citp-connect against a local stub "Capture" ----
function runProbe(phase, port, dir) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, 'research', 'citp-connect.mjs'), `--${phase}`, '--host', '127.0.0.1', '--port', String(port),
      '--duration', '2.5', '--report-dir', dir], { timeout: 30000 }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stdout}\n${stderr}`)) : resolve(stdout)));
  });
}

function startStub() {
  const received = [];
  const server = net.createServer((c) => {
    const framer = new CitpFramer();
    // as soon as a client connects: EnterShow + PNam back to back in ONE chunk
    c.write(Buffer.concat([buildCaexEmpty(CAEX.EnterShow), buildPNam('stub Capture')]));
    c.on('data', (d) => {
      received.push(d);
      for (const m of framer.push(d).messages) {
        if (m.length === 24 && m.toString('latin1', 16, 20) === 'CAEX' && m.readUInt32LE(20) === CAEX.FixtureListRequest) {
          const fl = buildFixtureList(FIXTURES);
          // reply split across chunks at awkward places, with small gaps
          const cuts = [7, 22, 51, fl.length];
          let prev = 0, i = 0;
          const next = () => { if (i >= cuts.length) return; c.write(fl.subarray(prev, cuts[i])); prev = cuts[i++]; setTimeout(next, 30); };
          next();
        }
      }
    });
    c.on('error', () => {});
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, received, port: server.address().port })));
}

for (const phase of ['observe', 'hello', 'caex']) {
  test(`citp-connect --${phase} against a stub server`, async () => {
    const stub = await startStub();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citp-test-'));
    try {
      await runProbe(phase, stub.port, dir);
      const rep = fs.readFileSync(path.join(dir, `citp-${phase}.txt`), 'utf8');
      assert.ok(rep.startsWith(`Phase: ${phase}\nTarget: 127.0.0.1:${stub.port}\n`), 'phase + target at top');
      assert.match(rep, /2 CITP message\(s\) received|CITP message\(s\) received/);
      assert.match(rep, /EnterShow/);
      assert.match(rep, /PNam: Name="stub Capture"/);
      const sent = Buffer.concat(stub.received);
      // what the probe is allowed to send, and nothing else
      const fr = new CitpFramer(); const msgs = fr.push(sent).messages;
      assert.equal(fr.pending, 0);
      if (phase === 'observe') assert.equal(sent.length, 0, 'observe sends nothing');
      if (phase === 'hello') { assert.equal(msgs.length, 1); assert.ok(msgs[0].equals(buildPNam('capture-streamdeck probe'))); }
      if (phase === 'caex') {
        assert.ok(msgs[0].equals(buildPNam('capture-streamdeck probe')), 'PNam first');
        assert.ok(msgs.length >= 2);
        for (const m of msgs.slice(1)) assert.ok(m.equals(buildFixtureListRequest()), 'only FixtureListRequest after hello');
        assert.match(rep, /FixtureList: Type=0 \(existing list\) FixtureCount=3/);
        assert.match(rep, /manufacturer="Martin" model="MAC Aura XB" mode="Extended" channels=22/);
        assert.match(rep, /universe=1 \(0-based\) address=100 \(0-based\)/);
        assert.match(rep, /guid-spec=00112233-4455-6677-8899-aabbccddeeff guid-raw=33221100-5544-7766-8899-aabbccddeeff/);
        assert.match(rep, /buffered, waiting for the rest of a message/, 'split reply was buffered across chunks');
      }
    } finally { stub.server.close(); }
  });
}

// ================= handoff 04: spec layouts, allowlist, --sync =================

const g = (hex) => Buffer.from(hex, 'hex');
const BASE_FIXTURE = g('11111111222233334444555555555555'), BASE_MODE = g('aaaaaaaabbbbccccddddeeeeeeeeeeee'), INSTANCE = g('33221100554477668899aabbccddeeff');
const FIXTURES2 = [
  { id: 7, mfr: 'Vari-Lite', name: 'VL3500 Spot', mode: 'Mode 1', channels: 32, universe: 0, address: 0, channel: 1,
    ids: [[0x02, BASE_FIXTURE], [0x03, BASE_MODE], [0x04, INSTANCE]] },
  { id: 9, mfr: 'Martin', name: 'MAC Aura XB', mode: 'Extended', channels: 22, universe: 1, address: 100, channel: 2 },
];

test('guid: spec example string <-> bytes (COM mixed-endian)', () => {
  assert.equal(guidStr(Buffer.from('33221100554477668899aabbccddeeff', 'hex')), '00112233-4455-6677-8899-aabbccddeeff');
});

test('encoders produce the spec byte layouts', () => {
  const hdr = (total, layer) => hexOf(buildHeader(total, layer));
  assert.equal(hexOf(buildLeaveShow()), `${hdr(24, 'CAEX')} 01 01 02 00`);
  assert.equal(hexOf(buildNack(3)), `${hdr(25, 'CAEX')} ff ff ff ff 03`);
  assert.equal(hexOf(buildLaserFeedList(0x11223344, [])), `${hdr(29, 'CAEX')} 01 01 03 00 44 33 22 11 00`);
  assert.equal(hexOf(buildLaserFeedList(1, ['A'])), `${hdr(33, 'CAEX')} 01 01 03 00 01 00 00 00 01 41 00 00 00`);
  assert.equal(hexOf(buildEnterShow('AB')), `${hdr(30, 'CAEX')} 00 01 02 00 41 00 42 00 00 00`);
  assert.equal(hexOf(buildFixtureListRequest()), `${hdr(24, 'CAEX')} 00 02 02 00`);
});

test('decoders: real EnterShow bytes, NACK, LaserFeedList, LeaveShow, Selection, Remove', () => {
  const es = decodeMessage(Buffer.concat([buildHeader(HEADER_SIZE + 4 + 22, 'CAEX'), g('00010200'), Buffer.from('DISRUPTION\0', 'utf16le')]));
  assert.equal(es.showName, 'DISRUPTION');
  assert.equal(decodeMessage(buildNack(3)).nackReason, 3);
  assert.match(decodeMessage(buildLaserFeedList(0xdeadbeef, [])).lines.join('\n'), /SourceKey=0xdeadbeef FeedCount=0/);
  assert.match(decodeMessage(buildLaserFeedList(1, ['Feed A', 'B'])).lines.join('\n'), /FeedCount=2 Names=\["Feed A","B"\]/);
  assert.match(decodeMessage(buildLeaveShow()).lines.join('\n'), /LeaveShow/);
  const body = (code, ...parts) => { const inner = Buffer.concat([u32(code), ...parts]); return Buffer.concat([buildHeader(HEADER_SIZE + inner.length, 'CAEX'), inner]); };
  const sel = decodeMessage(body(CAEX.FixtureSelection, u16(2), u32(7), u32(9)));
  assert.deepEqual(sel.selection, [7, 9]);
  assert.match(decodeMessage(body(CAEX.FixtureRemove, u16(1), u32(0xabc))).lines.join('\n'), /FixtureRemove: FixtureCount=1 identifiers=\[0x00000abc\]/);
  // FixtureModify (provisional layout): changed = 0x01|0x04 -> patched/universe/address then channel
  const mod = decodeMessage(body(CAEX.FixtureModify, u16(1), u32(7), Buffer.from([0x05]), Buffer.from([1, 2]), u16(300), u16(12)));
  assert.match(mod.lines.join('\n'), /id=0x00000007 changed=0x5 patched=1 universe=2\(0-based\) address=300\(0-based\) channel=12/);
});

test('FixtureList: 2 fixtures, one with 3 identifiers (AtlaBaseFixtureId, AtlaBaseModeId, CaptureInstanceId)', () => {
  const fl = decodeFixtureList(buildFixtureList(FIXTURES2));
  assert.equal(fl.error, null);
  assert.equal(fl.count, 2);
  const [a, b] = fl.fixtures;
  assert.equal(a.identifier, 7);
  assert.deepEqual(a.ids.map((d) => [d.type, d.name]), [[2, 'AtlaBaseFixtureId'], [3, 'AtlaBaseModeId'], [4, 'CaptureInstanceId']]);
  assert.equal(a.ids[0].guid, '11111111-2222-3333-4444-555555555555');
  assert.equal(a.ids[1].guid, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(a.ids[2].guid, '00112233-4455-6677-8899-aabbccddeeff');
  assert.deepEqual([a.manufacturer, a.name, a.mode, a.channelCount, a.universe, a.universeChannel, a.channel], ['Vari-Lite', 'VL3500 Spot', 'Mode 1', 32, 0, 0, 1]);
  assert.deepEqual([b.manufacturer, b.name, b.mode, b.channelCount, b.universe, b.universeChannel, b.channel], ['Martin', 'MAC Aura XB', 'Extended', 22, 1, 100, 2]);
  assert.deepEqual(a.position, [1, 2, 3]);
  assert.equal(b.ids.length, 2);
  const table = formatFixtureTables(fl.fixtures).join('\n');
  assert.match(table, /1 \[0\]\s+\| 1 \[0\]/, 'universe/address 1-based with raw 0-based');
  assert.match(table, /2 \[1\]\s+\| 101 \[100\]/);
  assert.match(table, /CaptureInstanceId\s+\| 16\s+\| 00112233-4455-6677-8899-aabbccddeeff/);
  const t = decodeMessage(buildFixtureList(FIXTURES2), '    ', { maxFixtures: 0 });
  assert.ok(!/manufacturer=/.test(t.lines.join('\n')), 'maxFixtures 0 logs no per-fixture lines');
});

test('outgoing allowlist: only PNam, LaserFeedList, EnterShow, FixtureListRequest, NACK, LeaveShow', () => {
  for (const m of [buildPNam('x'), buildLaserFeedList(1, []), buildEnterShow('x'), buildFixtureListRequest(), buildNack(3), buildLeaveShow()]) assert.ok(isAllowedOutgoing(m));
  const never = ['FixtureList', 'FixtureModify', 'FixtureRemove', 'FixtureIdentify', 'FixtureSelection', 'FixtureConsoleStatus', 'SetFixtureTransformationSpace',
    'SetCueRecordingCapabilities', 'RecordCue', 'ClearRecorder', 'LaserFeedControl', 'LaserFeedFrame'];
  for (const n of never) assert.equal(isAllowedOutgoing(buildCaexEmpty(CAEX[n])), false, n);
  assert.equal(isAllowedOutgoing(buildFixtureList(FIXTURES2)), false);
  assert.equal(isAllowedOutgoing(buildPLoc(1, 'a', 'b', 'c')), false);
  assert.equal(isAllowedOutgoing(Buffer.from('nonsense')), false);
});

function startSyncStub() {
  const received = [];
  const server = net.createServer((c) => {
    const framer = new CitpFramer();
    // Capture-like: right after connect it asks GetLaserFeedList and a request we do not serve
    c.write(Buffer.concat([buildCaexEmpty(CAEX.GetLaserFeedList), buildCaexEmpty(CAEX.GetLiveViewStatus)]));
    c.on('data', (d) => {
      for (const m of framer.push(d).messages) {
        received.push(m);
        if (m.toString('latin1', 16, 24) === 'PINFPNam') {
          // after PNam: EnterShow ("DISRUPTION") + a FixtureListRequest *from Capture*, in one chunk
          const es = Buffer.concat([buildHeader(HEADER_SIZE + 4 + 22, 'CAEX'), u32(CAEX.EnterShow), Buffer.from('DISRUPTION\0', 'utf16le')]);
          c.write(Buffer.concat([es, buildCaexEmpty(CAEX.FixtureListRequest)]));
        } else if (m.length === 24 && m.readUInt32LE(20) === CAEX.FixtureListRequest) {
          const fl = buildFixtureList(FIXTURES2);
          const sel = Buffer.concat([buildHeader(HEADER_SIZE + 4 + 2 + 4, 'CAEX'), u32(CAEX.FixtureSelection), u16(1), u32(9)]);
          const all = Buffer.concat([fl, sel]);
          const cuts = [5, 40, 77, fl.length + 3, all.length]; // splits inside the list and inside the selection message
          let prev = 0, i = 0;
          const next = () => { if (i >= cuts.length) return; c.write(all.subarray(prev, cuts[i])); prev = cuts[i++]; setTimeout(next, 25); };
          next();
        }
      }
    });
    c.on('error', () => {});
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, received, port: server.address().port })));
}

test('citp-connect --sync against a stub server', async () => {
  const stub = await startSyncStub();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citp-sync-'));
  try {
    await new Promise((resolve, reject) => execFile(process.execPath,
      [path.join(ROOT, 'research', 'citp-connect.mjs'), '--sync', '--host', '127.0.0.1', '--port', String(stub.port), '--duration', '3', '--report-dir', dir],
      { timeout: 30000 }, (e, so, se) => (e ? reject(new Error(`${e.message}\n${so}\n${se}`)) : resolve())));
    const rep = fs.readFileSync(path.join(dir, 'citp-sync.txt'), 'utf8');
    assert.ok(rep.startsWith(`Phase: sync\nTarget: 127.0.0.1:${stub.port}\n`));

    const got = stub.received;
    const kind = (m) => (m.toString('latin1', 16, 20) === 'PINF' ? 'PNam' : `caex:0x${m.readUInt32LE(20).toString(16).padStart(8, '0')}`);
    const kinds = got.map(kind);
    // every message on the wire is on the allowlist, and none is from the never-send list
    got.forEach((m) => assert.ok(isAllowedOutgoing(m), kind(m)));
    for (const bad of ['FixtureList', 'FixtureModify', 'FixtureRemove', 'FixtureIdentify', 'FixtureSelection', 'FixtureConsoleStatus', 'SetFixtureTransformationSpace']) {
      assert.ok(!kinds.includes(`caex:0x${CAEX[bad].toString(16).padStart(8, '0')}`), `never sent ${bad}`);
    }
    assert.equal(kinds[0], 'PNam');
    const laser = got.find((m) => m.length > 20 && m.readUInt32LE(20) === CAEX.LaserFeedList);
    assert.ok(laser, 'replied to GetLaserFeedList');
    assert.equal(laser[28], 0, 'FeedCount = 0');
    assert.equal(got.length && got.filter((m) => m.readUInt32LE(20) === CAEX.LaserFeedList).length, 1, 'exactly one LaserFeedList reply');
    const iEnter = kinds.indexOf('caex:0x00020100'), iReq = kinds.indexOf('caex:0x00020200');
    assert.ok(iEnter > 0 && iReq > iEnter, 'our EnterShow, then FixtureListRequest');
    assert.ok(got[iEnter].equals(buildEnterShow('capture-streamdeck probe')));
    const nacks = got.filter((m) => m.readUInt32LE(20) === CAEX.NACK);
    assert.equal(nacks.length, 2, 'NACK for GetLiveViewStatus and for Capture\'s FixtureListRequest');
    nacks.forEach((n) => assert.equal(n[24], 3, 'Reason 3 (refused)'));
    assert.equal(kinds[kinds.length - 1], 'caex:0x00020101', 'LeaveShow last');
    assert.equal(kinds.filter((k) => k === 'caex:0x00020101').length, 1);

    // decode side
    assert.match(rep, /FixtureList #1: Type=0 count=2/);
    assert.match(rep, /VL3500 Spot/); assert.match(rep, /MAC Aura XB/);
    assert.match(rep, /AtlaBaseFixtureId/); assert.match(rep, /AtlaBaseModeId/); assert.match(rep, /CaptureInstanceId/);
    assert.match(rep, /FIXTURE SELECTION: 0x00000009 \(Martin MAC Aura XB, ch 2\)/);
    assert.match(rep, /FixtureSelection events: 1/);
    assert.match(rep, /replying NACK Reason 3/);
    assert.match(rep, /SEND CAEX LeaveShow/);
    assert.match(rep, /buffered, waiting for the rest of a message/);
  } finally { stub.server.close(); }
});

test('GUID dual form: MAC Aura XB AtlaBaseFixtureId (raw order = library filename, spec = mixed-endian)', () => {
  const rawStr = '2f7c6351-e151-4c44-beca-80bb03902631';
  const bytes = Buffer.from(rawStr.replace(/-/g, ''), 'hex');
  assert.equal(guidRawStr(bytes), rawStr);
  assert.equal(guidStr(bytes), '51637c2f-51e1-444c-beca-80bb03902631');
  // through the FixtureList decoder and the identifiers table
  const fl = decodeFixtureList(buildFixtureList([{ mfr: 'Martin', name: 'MAC Aura XB', mode: 'Standard', channels: 14, universe: 0, address: 0, channel: 1, ids: [[0x02, bytes]] }]));
  const id = fl.fixtures[0].ids[0];
  assert.equal(id.guidRaw, rawStr);
  assert.equal(id.guidSpec, '51637c2f-51e1-444c-beca-80bb03902631');
  const table = formatFixtureTables(fl.fixtures).join('\n');
  assert.match(table, /size \| value\s+\| raw/);
  assert.match(table, /51637c2f-51e1-444c-beca-80bb03902631 \| 2f7c6351-e151-4c44-beca-80bb03902631/);
});
