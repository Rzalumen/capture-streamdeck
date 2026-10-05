// Handoff 25: the SDMX layer — declaration builders, the opt-in allowlist, the decoder, and `citp-connect --sdmx [--declare]` end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CAEX, CitpFramer, HEADER_SIZE, buildCaexEmpty, buildFixtureIdentify, buildHeader, buildSxsr, buildSxus, decodeMessage, decodeSdmx,
  isAllowedOutgoing, isWellFormedDeclaration, parseUniverses,
} from '../lib/citp.mjs';
import { buildPatchMessage } from './synth-modes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'research', 'citp-connect.mjs');
const w32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const enterShow = (name) => Buffer.concat([buildHeader(HEADER_SIZE + 4 + (name.length + 1) * 2, 'CAEX'), w32(CAEX.EnterShow), Buffer.from(name + '\0', 'utf16le')]);
const sdmx = (type, body) => Buffer.concat([buildHeader(HEADER_SIZE + 4 + body.length, 'SDMX'), Buffer.from(type, 'latin1'), body]);
/** SDMX/ChBk as Capture might send it: u8 Blind, u8 UniverseIndex, u16 FirstChannel, u16 ChannelCount, u8 levels[] */
const chbk = (universeIndex, first, levels) => { const h = Buffer.alloc(6); h[0] = 0; h[1] = universeIndex; h.writeUInt16LE(first, 2); h.writeUInt16LE(levels.length, 4); return sdmx('ChBk', Buffer.concat([h, Buffer.from(levels)])); };
const kind = (m) => { const l = m.toString('latin1', 16, 20); return l === 'PINF' ? m.toString('latin1', 20, 24) : l === 'SDMX' ? `sdmx:${m.toString('latin1', 20, 24)}` : `caex:0x${m.readUInt32LE(20).toString(16).padStart(8, '0')}`; };
const ROGUE = [{ mfr: 'Rogue', name: 'R2X Wash', mode: 'Extended', channels: 22, universe: 0, address: 0, channel: 203, patched: false }];

// ---------------------------------------------------------------- builders: byte layout against the spec text
//   struct CITP_SDMX_Header { CITP_Header CITPHeader; uint32 ContentType; }          (CITP ContentType "SDMX"; PA14 spec, citp-lib)
//   SXSr: struct CITP_SDMX_SXSr { CITP_SDMX_Header; ucs1 ConnectionString[]; }        (citp-lib CITPDefines.h; nannou citp sdmx.rs)
//   SXUS: { CITP_SDMX_Header; uint8 UniverseIndex /* 0-based */; ucs1 ConnectionString[]; }   (nannou citp sdmx.rs, "as the SXSr message")
//   BSR E1.31 / sACN connection string: "BSRE1.31/<universe>/<channel>", "BSRE1.31/1/1" = first channel of the first universe.

test('SXUS byte layout: CITP header (SDMX) + "SXUS" + u8 UniverseIndex (0-based) + ucs1 "BSRE1.31/<u>/1"', () => {
  const m = buildSxus(3);
  const cs = Buffer.from('BSRE1.31/3/1\0', 'latin1');
  assert.equal(m.length, 20 + 4 + 1 + cs.length);
  assert.equal(m.toString('latin1', 0, 4), 'CITP');
  assert.deepEqual([m[4], m[5]], [1, 0], 'CITP version 1.0');
  assert.equal(m.readUInt32LE(8), m.length, 'MessageSize = whole message');
  assert.deepEqual([m.readUInt16LE(12), m.readUInt16LE(14)], [1, 0], 'one part');
  assert.equal(m.toString('latin1', 16, 20), 'SDMX', 'CITP ContentType');
  assert.equal(m.readUInt32LE(16), 0x584d4453, "citp-lib COOKIE_SDMX 0x584d4453 'SDMX'");
  assert.equal(m.toString('latin1', 20, 24), 'SXUS', 'SDMX ContentType');
  assert.equal(m[24], 2, 'UniverseIndex is 0-based: universe 3 -> 2');
  assert.deepEqual(m.subarray(25), cs, 'null-terminated 8-bit connection string');
  assert.throws(() => buildSxus(0), RangeError);
  assert.throws(() => buildSxus(257), RangeError, 'UniverseIndex is a u8');
});

test('SXSr byte layout: CITP header (SDMX) + "SXSr" + ucs1 "BSRE1.31/<base>/1"', () => {
  const m = buildSxsr(1);
  assert.equal(m.toString('latin1', 16, 24), 'SDMXSXSr');
  assert.equal(m.readUInt32LE(20), 0x72535853, "citp-lib COOKIE_SDMX_SXSR 0x72535853 'SXSr'");
  assert.deepEqual(m.subarray(24), Buffer.from('BSRE1.31/1/1\0', 'latin1'));
  assert.equal(m.readUInt32LE(8), m.length);
});

test('allowlist: every SDMX message is refused by default; {sdmxDeclare: true} accepts ONLY our well-formed SXSr / SXUS', () => {
  const good = [buildSxsr(1), buildSxus(1), buildSxus(16), buildSxus(256)];
  for (const m of good) {
    assert.equal(isAllowedOutgoing(m), false, 'default: refused');
    assert.equal(isAllowedOutgoing(m, { identify: true }), false, '--identify does not open SDMX');
    assert.equal(isAllowedOutgoing(m, { sdmxDeclare: true }), true);
    assert.equal(isWellFormedDeclaration(m), true);
  }
  const bad = {
    'SXUS index not universe-1': (() => { const m = buildSxus(2); m[24] = 5; return m; })(),
    'declared size wrong': (() => { const m = buildSxus(1); m.writeUInt32LE(m.length + 1, 8); return m; })(),
    'a byte after the string': (() => { const m = buildSxus(1); const x = Buffer.concat([m, Buffer.from([0])]); x.writeUInt32LE(x.length, 8); return x; })(),
    'no terminating null': (() => { const m = buildSxsr(1).subarray(0, -1); const x = Buffer.from(m); x.writeUInt32LE(x.length, 8); return x; })(),
    'Art-Net string': sdmx('SXSr', Buffer.from('ArtNet/0/0/1\0', 'latin1')),
    'sACN channel other than 1': sdmx('SXSr', Buffer.from('BSRE1.31/1/5\0', 'latin1')),
    'universe 0': sdmx('SXSr', Buffer.from('BSRE1.31/0/1\0', 'latin1')),
    'multi-part header': (() => { const m = buildSxsr(1); m.writeUInt16LE(2, 12); return m; })(),
    'ChBk (DMX levels)': chbk(0, 0, [255, 0, 128]),
    'ChLs (DMX levels)': sdmx('ChLs', Buffer.from([1, 0, 0, 0, 0, 255])),
    Capa: sdmx('Capa', Buffer.from([1, 0, 3, 0])),
    UNam: sdmx('UNam', Buffer.from('\0U1\0', 'latin1')),
    EnId: sdmx('EnId', Buffer.from('x\0', 'latin1')),
  };
  for (const [what, m] of Object.entries(bad)) {
    assert.equal(isAllowedOutgoing(m, { sdmxDeclare: true }), false, what);
    assert.equal(isAllowedOutgoing(m), false, what);
  }
  // nothing else changes: FixtureIdentify still needs {identify}, and sdmxDeclare does not open it
  const fi = buildFixtureIdentify([{ guid: Buffer.alloc(16, 1), identifier: 100001 }]);
  assert.equal(isAllowedOutgoing(fi, { sdmxDeclare: true }), false);
  assert.equal(isAllowedOutgoing(buildCaexEmpty(CAEX.FixtureListRequest), { sdmxDeclare: true }), true, 'the old allowlist is unchanged');
});

test('decodeSdmx: ChBk / ChLs are flagged as level data; Capa, UNam, SXSr, SXUS decode; an unknown type with a body is flagged; never throws', () => {
  const b = decodeSdmx(chbk(1, 284, [10, 20, 30]));
  assert.deepEqual([b.type, b.universeIndex, b.firstChannel, b.levels, b.levelLike], ['ChBk', 1, 284, [10, 20, 30], true]);
  const l = decodeSdmx(sdmx('ChLs', Buffer.from([2, 0, 0, 5, 0, 99, 1, 7, 0, 1])));
  assert.deepEqual(l.levels, [{ universeIndex: 0, channel: 5, level: 99 }, { universeIndex: 1, channel: 7, level: 1 }]);
  assert.equal(l.levelLike, true);
  assert.deepEqual(decodeSdmx(sdmx('Capa', Buffer.from([2, 0, 1, 0, 102, 0]))).caps, [1, 102]);
  assert.match(decodeSdmx(sdmx('Capa', Buffer.from([1, 0, 3, 0]))).lines[0], /3 \(SXUS per-universe external sources\)/);
  assert.equal(decodeSdmx(sdmx('UNam', Buffer.from('\x02Front\0', 'latin1'))).name, 'Front');
  assert.equal(decodeSdmx(buildSxus(4)).connectionString, 'BSRE1.31/4/1');
  assert.equal(decodeSdmx(buildSxsr(1)).levelLike, false);
  const u = decodeSdmx(sdmx('Zzzz', Buffer.alloc(32, 7)));
  assert.equal(u.unknown, true);
  assert.equal(u.levelLike, true, 'unknown SDMX with a channel-sized body: flagged');
  const t = decodeSdmx(sdmx('ChBk', Buffer.from([0, 0, 0])));
  assert.match(t.error, /need/);
  assert.equal(decodeMessage(chbk(0, 0, [1])).sub, 'ChBk', 'decodeMessage routes the SDMX layer');
});

test('parseUniverses: 1-16 by default, lists and ranges, 1..256 only', () => {
  assert.deepEqual(parseUniverses(), Array.from({ length: 16 }, (_, i) => i + 1));
  assert.deepEqual(parseUniverses('3, 1,5-7'), [1, 3, 5, 6, 7]);
  for (const bad of ['0', '257', 'x', '5-2', '']) assert.throws(() => parseUniverses(bad), Error, bad);
});

// ---------------------------------------------------------------- end to end: citp-connect --sdmx against a stub Capture

/** A Capture stand-in: EnterShow after PNam, a list for every request; optionally sends SDMX messages after it entered. */
async function startStub({ sendSdmx = [] } = {}) {
  const rec = { received: [] };
  const server = net.createServer((c) => {
    const framer = new CitpFramer();
    c.on('data', (d) => {
      for (const m of framer.push(d).messages) {
        rec.received.push(m);
        if (m.toString('latin1', 16, 24) === 'PINFPNam') { c.write(enterShow('SDMX SHOW')); setTimeout(() => sendSdmx.forEach((x) => c.write(x)), 300); }
        else if (m.length === 24 && m.readUInt32LE(20) === CAEX.FixtureListRequest) c.write(buildPatchMessage(ROGUE));
      }
    });
    c.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, rec, port: server.address().port };
}
async function runProbe(port, extra, seconds = '2.5') {
  const udp = dgram.createSocket('udp4'); await new Promise((r) => udp.bind(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citp-sdmx-'));
  try {
    const r = await new Promise((resolve) => execFile(process.execPath, [SCRIPT, '--sdmx', ...extra, '--host', '127.0.0.1', '--port', String(port), '--seconds', seconds, '--rerequest-seconds', '1', '--announce-dest', `127.0.0.1:${udp.address().port}`, '--report-dir', dir], { timeout: 60000 }, (e, so, se) => resolve({ code: e ? e.code : 0, so, se })));
    assert.equal(r.code, 0, r.so + r.se);
    return fs.readFileSync(path.join(dir, 'citp-sdmx.txt'), 'utf8');
  } finally { udp.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('--sdmx (listen only) with a stub that sends fabricated SDMX: logged with decode and raw hex, LEVEL DATA flagged loudly; nothing SDMX is sent', async () => {
  const fake = [chbk(0, 284, [255, 128, 0, 64]), sdmx('Capa', Buffer.from([1, 0, 3, 0]))];
  const stub = await startStub({ sendSdmx: fake });
  try {
    const rep = await runProbe(stub.port, []);
    assert.ok(rep.startsWith(`Phase: sdmx\nTarget: 127.0.0.1:${stub.port}\n`));
    assert.match(rep, /\[out\] SDMX RECEIVED "ChBk" \(34 bytes\) {3}<<<<< LOOKS LIKE DMX LEVEL DATA >>>>>/);
    assert.ok(rep.includes(`hex: ${[...fake[0]].map((x) => x.toString(16).padStart(2, '0')).join(' ')}`), 'raw hex of the ChBk');
    assert.match(rep, /SDMX ChBk \(DMX LEVELS\): Blind=0 UniverseIndex=0 \(universe 1\) FirstChannel=284 \(address 285\) ChannelCount=4/);
    assert.match(rep, /levels: 255 128 0 64/);
    assert.match(rep, /SDMX RECEIVED "Capa".*\n.*\n(.*\n)*.*3 \(SXUS per-universe external sources\)/);
    assert.match(rep, /== SDMX summary ==\n {2}SDMX messages RECEIVED: 2 \(ChBk x1, Capa x1; on: out\)/);
    assert.match(rep, /declaration sent: NO \(listen only; --declare not given\)/);
    assert.match(rep, /!!! LEVEL DATA: 1 SDMX message\(s\) carrying channel-sized payloads/);
    // on the wire: no SDMX, no FixtureIdentify, only the --link set
    for (const m of stub.rec.received) assert.ok(isAllowedOutgoing(m), kind(m));
    assert.ok(!stub.rec.received.some((m) => kind(m).startsWith('sdmx:')), 'listen only: no SDMX sent');
    assert.ok(!stub.rec.received.map(kind).includes('caex:0x00020204'), 'no FixtureIdentify');
  } finally { stub.server.close(); }
});

test('--sdmx --declare: after our EnterShow, SXSr (base 1) + SXUS for universes 1–16, each well-formed; no DMX, no FixtureIdentify; the stub sends no SDMX → "no SDMX received"', async () => {
  const stub = await startStub();
  try {
    const rep = await runProbe(stub.port, ['--declare']);
    const k = stub.rec.received.map(kind);
    const sd = stub.rec.received.filter((m) => kind(m).startsWith('sdmx:'));
    assert.deepEqual(sd.map(kind), ['sdmx:SXSr', ...Array(16).fill('sdmx:SXUS')]);
    sd.forEach((m) => assert.ok(isWellFormedDeclaration(m)));
    assert.deepEqual(sd.slice(1).map((m) => [m[24], decodeSdmx(m).connectionString]), Array.from({ length: 16 }, (_, i) => [i, `BSRE1.31/${i + 1}/1`]));
    assert.equal(decodeSdmx(sd[0]).connectionString, 'BSRE1.31/1/1');
    assert.ok(k.indexOf('caex:0x00020100') < k.indexOf('sdmx:SXSr'), 'declared after our EnterShow');
    assert.ok(!k.includes('sdmx:ChBk') && !k.includes('sdmx:ChLs') && !k.includes('caex:0x00020204'), 'no DMX, no FixtureIdentify');
    for (const m of stub.rec.received) assert.ok(isAllowedOutgoing(m, { sdmxDeclare: true }), kind(m));
    assert.match(rep, /SDMX messages RECEIVED: 0 -- no SDMX received on any connection/);
    assert.match(rep, /declaration sent: YES, 17 message\(s\) \(SXSr x1, SXUS x16\) for sACN universe\(s\) 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16, on out at \+/);
    assert.match(rep, /level data \(ChBk \/ ChLs \/ anything channel-sized\): NONE received/);
    assert.match(rep, /\[out\] SDMX SENT "SXUS" \(38 bytes\)/);
  } finally { stub.server.close(); }
});

test('--sdmx --declare --universes 1,3: not consecutive → SXUS only (no SXSr base)', async () => {
  const stub = await startStub();
  try {
    await runProbe(stub.port, ['--declare', '--universes', '1,3'], '1.5');
    const sd = stub.rec.received.filter((m) => kind(m).startsWith('sdmx:'));
    assert.deepEqual(sd.map((m) => [kind(m), m[24]]), [['sdmx:SXUS', 0], ['sdmx:SXUS', 2]]);
  } finally { stub.server.close(); }
});
