import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CAEX, CitpFramer, HEADER_SIZE, buildCaexEmpty, buildHeader, decodeFixtureList, decodeMessage, isAllowedOutgoing } from '../lib/citp.mjs';
import { buildPatchMessage } from './synth-modes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'research', 'citp-connect.mjs');
const w32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const enterShow = (name) => Buffer.concat([buildHeader(HEADER_SIZE + 4 + (name.length + 1) * 2, 'CAEX'), w32(CAEX.EnterShow), Buffer.from(name + '\0', 'utf16le')]);
const kind = (m) => (m.toString('latin1', 16, 20) === 'PINF' ? m.toString('latin1', 20, 24) : `caex:0x${m.readUInt32LE(20).toString(16).padStart(8, '0')}`);
const FORBIDDEN = ['FixtureList', 'FixtureModify', 'FixtureRemove', 'FixtureIdentify', 'FixtureSelection', 'FixtureConsoleStatus', 'SetFixtureTransformationSpace'].map((n) => `caex:0x${CAEX[n].toString(16).padStart(8, '0')}`);

// Rogue-like fixtures exactly as Reza's Capture reports them: Channel set, patch fields empty. After the 3rd FixtureListRequest
// the stub starts sending real patch values (what we hope linking changes).
const ROGUES = (patched) => [
  { mfr: 'Rogue', name: 'R2X Wash', mode: 'Extended', channels: 22, universe: patched ? 0 : 0, address: patched ? 284 : 0, channel: 203, patched },
  { mfr: 'Rogue', name: 'R2X Wash', mode: 'Extended', channels: 22, universe: 0, address: patched ? 306 : 0, channel: 204, patched },
  { mfr: 'Rogue', name: 'R2X Wash', mode: 'Extended', channels: 22, universe: 0, address: 0, channel: 205, patched: false },
  { mfr: 'Rogue', name: 'R2X Wash', mode: 'Extended', channels: 22, universe: 0, address: 0, channel: 206, patched: false },
];

function startCaptureStub() {
  const rec = { received: [], requests: 0 };
  const server = net.createServer((c) => {
    const framer = new CitpFramer();
    c.write(buildCaexEmpty(CAEX.GetLaserFeedList));
    c.on('data', (d) => {
      for (const m of framer.push(d).messages) {
        rec.received.push(m);
        if (m.toString('latin1', 16, 24) === 'PINFPNam') c.write(enterShow('DISRUPTION'));
        else if (m.length === 24 && m.readUInt32LE(20) === CAEX.FixtureListRequest) { rec.requests++; c.write(buildPatchMessage(ROGUES(rec.requests >= 3))); }
      }
    });
    c.on('error', () => {});
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, rec, port: server.address().port })));
}

test('citp-connect --link: announces a LightingConsole every second, re-requests the patch, answers an inbound connection by the allowlist, summarises every FixtureList', async () => {
  const stub = await startCaptureStub();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citp-link-'));
  // where the announcement goes (stand-in for the multicast groups)
  const udp = dgram.createSocket('udp4'); const announces = [];
  udp.on('message', (m) => announces.push({ t: Date.now(), m }));
  await new Promise((r) => udp.bind(0, '127.0.0.1', r));
  let child;
  try {
    const p = new Promise((resolve) => { child = execFile(process.execPath, [SCRIPT, '--link', '--host', '127.0.0.1', '--port', String(stub.port), '--seconds', '6', '--rerequest-seconds', '1', '--announce-dest', `127.0.0.1:${udp.address().port}`, '--report-dir', dir], { timeout: 60000 }, (e, so, se) => resolve({ code: e ? e.code : 0, so, se })); });

    // act as Capture on the console link: connect to the TCP port named in the announcement
    await new Promise((res) => { const t = setInterval(() => { if (announces.length) { clearInterval(t); res(); } }, 20); });
    const ploc = decodeMessage(announces[0].m).ploc;
    assert.deepEqual([ploc.type, ploc.name, ploc.state], ['LightingConsole', 'capture-streamdeck probe', 'Running']);
    const inbound = { received: [], framer: new CitpFramer() };
    const c = net.connect({ host: '127.0.0.1', port: ploc.port });
    await new Promise((res) => c.once('connect', res));
    c.on('data', (d) => inbound.framer.push(d).messages.forEach((m) => inbound.received.push(m)));
    await new Promise((s) => setTimeout(s, 300));
    c.write(Buffer.concat([buildCaexEmpty(CAEX.GetLaserFeedList), buildCaexEmpty(CAEX.GetLiveViewStatus), enterShow('DISRUPTION')]));
    await new Promise((s) => setTimeout(s, 600));
    c.write(buildPatchMessage(ROGUES(true)));

    const r = await p;
    assert.equal(r.code, 0, r.so + r.se);
    c.destroy();
    const rep = fs.readFileSync(path.join(dir, 'citp-link.txt'), 'utf8');
    assert.ok(rep.startsWith(`Phase: link\nTarget: 127.0.0.1:${stub.port}\n`));

    // announcements: only PLoc/LightingConsole, about once a second, ListeningTCPPort constant
    assert.ok(announces.length >= 5 && announces.length <= 8, `announcements: ${announces.length}`);
    announces.forEach((a) => { const d = decodeMessage(a.m).ploc; assert.equal(d.type, 'LightingConsole'); assert.equal(d.port, ploc.port); });
    const gaps = announces.slice(1).map((a, i) => a.t - announces[i].t);
    gaps.forEach((g) => assert.ok(g > 800 && g < 1300, `announcement gap ${g} ms`));

    // outbound connection: PNam first, then only allowlisted messages, patch re-requested every second, LeaveShow last
    const out = stub.rec.received;
    out.forEach((m) => assert.ok(isAllowedOutgoing(m), kind(m)));
    assert.equal(kind(out[0]), 'PNam');
    assert.ok(stub.rec.requests >= 5, `FixtureListRequests: ${stub.rec.requests}`);
    assert.equal(kind(out[out.length - 1]), 'caex:0x00020101', 'LeaveShow last');
    FORBIDDEN.forEach((k) => assert.ok(!out.map(kind).includes(k) && !inbound.received.map(kind).includes(k), `never sent ${k}`));

    // inbound connection: we spoke first with PNam; then LaserFeedList (empty), NACK 3, our EnterShow + FixtureListRequest, and LeaveShow at the end
    inbound.received.forEach((m) => assert.ok(isAllowedOutgoing(m), kind(m)));
    const ik = inbound.received.map(kind);
    assert.equal(ik[0], 'PNam');
    assert.ok(ik.includes('caex:0x00030101'), 'LaserFeedList reply');
    assert.equal(inbound.received.find((m) => m.readUInt32LE(20) === CAEX.LaserFeedList)[28], 0, 'FeedCount 0');
    const nack = inbound.received.find((m) => m.readUInt32LE(20) === CAEX.NACK);
    assert.ok(nack && nack[24] === 3, 'NACK Reason 3 for GetLiveViewStatus');
    assert.ok(ik.indexOf('caex:0x00020100') > 0 && ik.indexOf('caex:0x00020200') > ik.indexOf('caex:0x00020100'), 'our EnterShow, then FixtureListRequest');
    assert.ok(ik.filter((k) => k === 'caex:0x00020200').length >= 2, 're-requested on the inbound connection too');

    // log: inbound connection reported, one summary line per FixtureList with the Patched=1 count
    assert.match(rep, /TCP INBOUND CONNECTION #1 from 127\.0\.0\.1/);
    assert.match(rep, /\[in#1\] .*RECV message #1/);
    assert.match(rep, /\[out\] .*FixtureList #1 \(list 1 overall\): count=4 Type=0 patched\(Patched=1\)=0\n/);
    assert.match(rep, /\[out\] .*patched\(Patched=1\)=2 first 2: Rogue R2X Wash 1\/285 ch 203; Rogue R2X Wash 1\/307 ch 204/);
    assert.match(rep, /\[in#1\] .*FixtureList #1 .*patched\(Patched=1\)=2 first 2: /);
    // full tables only twice: first list, and first list with a patched fixture
    assert.equal(rep.split('---- fixture tables (').length - 1, 2);
    assert.match(rep, /---- fixture tables \(first list\) ----/);
    assert.match(rep, /---- fixture tables \(first list with a patched fixture\) ----/);
    // summary block
    assert.match(rep, /== Link summary ==/);
    assert.match(rep, /Console announcements: \d+ round\(s\), \d+ send\(s\) ok, 0 failed/);
    assert.match(rep, /Inbound TCP connections from Capture: 1/);
    assert.match(rep, /connection out: \d+ FixtureList\(s\), \d+ with at least one Patched=1 \(most in one list: 2; first at \+/);
    assert.match(rep, /connection in#1: 1 FixtureList\(s\), 1 with at least one Patched=1/);
    assert.match(rep, /Patched=1 seen in any FixtureList: YES/);
    assert.match(rep, /\[in#1\] .*SEND CAEX LeaveShow/);
    assert.match(rep, /\[out\] .*SEND CAEX LeaveShow/);
    // decode sanity of what the stub sent (patch fields empty then filled)
    assert.equal(decodeFixtureList(buildPatchMessage(ROGUES(false))).fixtures.filter((f) => f.patched).length, 0);
  } finally { udp.close(); stub.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('citp-connect --link: no inbound connection and no patch ever sent -> says so plainly', async () => {
  const server = net.createServer((c) => {
    const framer = new CitpFramer();
    c.on('data', (d) => { for (const m of framer.push(d).messages) { if (m.toString('latin1', 16, 24) === 'PINFPNam') c.write(enterShow('X')); else if (m.length === 24 && m.readUInt32LE(20) === CAEX.FixtureListRequest) c.write(buildPatchMessage(ROGUES(false))); } });
    c.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const udp = dgram.createSocket('udp4'); await new Promise((r) => udp.bind(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citp-link-'));
  try {
    await new Promise((resolve, reject) => execFile(process.execPath, [SCRIPT, '--link', '--host', '127.0.0.1', '--port', String(server.address().port), '--seconds', '2.5', '--rerequest-seconds', '1', '--announce-dest', `127.0.0.1:${udp.address().port}`, '--report-dir', dir], { timeout: 60000 }, (e, so, se) => (e ? reject(new Error(so + se)) : resolve())));
    const rep = fs.readFileSync(path.join(dir, 'citp-link.txt'), 'utf8');
    assert.match(rep, /Inbound TCP connections from Capture: 0/);
    assert.match(rep, /Patched=1 seen in any FixtureList: NO/);
    assert.equal(rep.split('---- fixture tables (').length - 1, 1, 'full table only for the first list');
  } finally { udp.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
