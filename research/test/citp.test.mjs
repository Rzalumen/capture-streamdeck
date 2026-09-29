import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CAEX, CitpFramer, HEADER_SIZE, buildCaexEmpty, buildFixtureListRequest, buildHeader, buildPLoc, buildPNam,
  decodeFixtureList, decodeMessage,
} from '../lib/citp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ucs2 = (s) => Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.from([0, 0])]);
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b; };

// Test-only builder for a CAEX FixtureList laid out as in CAEX spec F (as summarised; see lib/citp.mjs).
const GUID_BYTES = Buffer.from('33221100554477668899aabbccddeeff', 'hex'); // 00112233-4455-6677-8899-aabbccddeeff
export function buildFixtureList(fixtures) {
  const body = [Buffer.from([0]), u16(fixtures.length)];
  for (const f of fixtures) {
    body.push(u32(f.id ?? 0xffffffff), ucs2(f.mfr), ucs2(f.name), ucs2(f.mode), u16(f.channels), Buffer.from([0]),
      Buffer.from([2]),
      Buffer.from([0x05]), u16(2), u16(0x1234),
      Buffer.from([0x02]), u16(16), GUID_BYTES,
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
  assert.equal(fl.fixtures[0].ids[0].value, 0x1234);
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
        assert.match(rep, /FixtureList: Type=0 \(existing patch\) FixtureCount=3/);
        assert.match(rep, /manufacturer="Martin" model="MAC Aura XB" mode="Extended" channels=22/);
        assert.match(rep, /universe=1 \(0-based\) address=100 \(0-based\)/);
        assert.match(rep, /guid=00112233-4455-6677-8899-aabbccddeeff/);
        assert.match(rep, /buffered, waiting for the rest of a message/, 'split reply was buffered across chunks');
      }
    } finally { stub.server.close(); }
  });
}
