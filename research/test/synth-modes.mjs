// Builds synthetic DMX-mode blocks in the verified layout (see lib/modes.mjs). Test data only; no Capture content.
//   [16-byte GUID][u32 len+1, name][u32 propCount]{key len+1, u32 type, value len+1}[u32 channelCount]{channel record}
//   channel record = name (u32 len=bytes+1, no terminator) + u8 role + u16 pair + UNDECODED TAIL (here: filler and decoy strings)
import { lpEncode } from '../lib/c2z.mjs';
import { comGuidBytes, rawGuidBytes } from '../lib/modes.mjs';

const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };

/** Small deterministic PRNG so "random" tails are the same on every run. */
export function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** A tail that contains decoy strings (wheel slot names ...) followed by bytes that are NOT a valid role/pair, plus filler. */
export function decoyTail(i, names = ['Open', 'Red', 'Gobo 3', 'Pan']) {
  const parts = [Buffer.from([0x11, 0x22, 0x33, 0x44])];
  for (const n of names) parts.push(lpEncode(n), Buffer.from([0x07, 0x01, 0x02])); // role 7 is never valid
  parts.push(Buffer.alloc(5, 0xcc));
  return Buffer.concat(parts);
}

/**
 * channels: [{name, role, pair, tail?: Buffer | (i)=>Buffer}]; role 0 -> pair 0xFFFF is filled in.
 * encoding 'com' (the verified one) or 'raw'. Returns the block bytes (GUID first).
 */
export function buildModeBlock({ guid, encoding = 'com', name = 'Standard', props = [['Key', 3, 'Value']], channels, count }) {
  const parts = [encoding === 'com' ? comGuidBytes(guid) : rawGuidBytes(guid), lpEncode(name), u32(props.length)];
  for (const [k, t, v] of props) parts.push(lpEncode(k), u32(t), lpEncode(v));
  parts.push(u32(count ?? channels.length));
  channels.forEach((c, i) => {
    parts.push(lpEncode(c.name), Buffer.from([c.role ?? 0]), u16((c.role ?? 0) === 0 ? 0xffff : c.pair));
    const tail = typeof c.tail === 'function' ? c.tail(i) : c.tail;
    if (tail) parts.push(tail);
  });
  return Buffer.concat(parts);
}

/** An object: filler header, a block, filler, optionally a second block. */
export function buildObject(...blocks) {
  return Buffer.concat([Buffer.alloc(24, 0xab), ...blocks.flatMap((b) => [b, Buffer.alloc(40, 0xab)])]);
}

// a moving light with interleaved 16-bit channels and an 8-bit dimmer; names are arbitrary on purpose
export const sampleChannels = (tail) => [
  { name: 'Pan', role: 1, pair: 1, tail }, { name: 'Pan Fine', role: 2, pair: 0, tail },
  { name: 'Tilt', role: 1, pair: 3, tail }, { name: 'Tilt Fine', role: 2, pair: 2, tail },
  { name: 'Beam Dimmer', role: 0, tail }, { name: 'Shutter', role: 0, tail },
  { name: 'Color Wheel', role: 0, tail }, { name: 'Gobo Wheel', role: 0, tail },
];

// ---- a synthetic Library.c2z holding given objects, and a stub CITP server serving a given patch ----
import zlib from 'node:zlib';
import net from 'node:net';
import { CAEX, CitpFramer, HEADER_SIZE, buildCaexEmpty, buildHeader } from '../lib/citp.mjs';

const u16z = (s) => Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.from([0, 0])]);

/** objects: {'<raw guid>': Buffer}. Returns the bytes of a Library.c2z (tree zlib stream, then one zlib stream per object). */
export function buildLibraryFile(objects) {
  const data = [], meta = [];
  let off = 0;
  for (const [guid, b] of Object.entries(objects)) { const z = zlib.deflateSync(b); meta.push([`${guid}.c2o`, off, b.length]); data.push(z); off += z.length; }
  const tree = Buffer.concat([Buffer.from('c2z '), Buffer.alloc(12), ...meta.map(([n, o, s]) => {
    const t = Buffer.alloc(8); t.writeUInt32LE(o); t.writeUInt32LE(s, 4); return Buffer.concat([u16z(n), t]);
  })]);
  return Buffer.concat([zlib.deflateSync(tree), ...data]);
}

const ucs2 = (s) => Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.from([0, 0])]);
const w16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const w32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const wf = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b; };

/** A CAEX FixtureList message. fixtures: [{mfr,name,mode,channels,universe,address,patched?,fixtureGuid?,modeGuid?}] (guids = raw-order strings). */
export function buildPatchMessage(fixtures) {
  const body = [Buffer.from([0]), w16(fixtures.length)];
  fixtures.forEach((f, i) => {
    const ids = [];
    if (f.fixtureGuid) ids.push([0x02, rawGuidBytes(f.fixtureGuid)]);
    if (f.modeGuid) ids.push([0x03, rawGuidBytes(f.modeGuid)]);
    body.push(w32(100 + i), ucs2(f.mfr), ucs2(f.name), ucs2(f.mode), w16(f.channels), Buffer.from([0]), Buffer.from([ids.length]),
      ...ids.flatMap(([t, d]) => [Buffer.from([t]), w16(d.length), d]),
      Buffer.from([f.patched === false ? 0 : 1, f.universe]), w16(f.address), ucs2(''), w16(i + 1), ucs2(''), ucs2(''),
      wf(0), wf(0), wf(0), wf(0), wf(0), wf(0));
  });
  const inner = Buffer.concat([w32(CAEX.FixtureList), ...body]);
  return Buffer.concat([buildHeader(HEADER_SIZE + inner.length, 'CAEX'), inner]);
}

/** Stub Capture: after PNam sends EnterShow, answers FixtureListRequest with the patch. Records everything it receives. */
export function startPatchStub(fixtures, { showName = 'STUB SHOW' } = {}) {
  const received = [];
  const server = net.createServer((c) => {
    const framer = new CitpFramer();
    c.write(buildCaexEmpty(CAEX.GetLaserFeedList));
    c.on('data', (d) => {
      for (const m of framer.push(d).messages) {
        received.push(m);
        if (m.toString('latin1', 16, 24) === 'PINFPNam') {
          const es = Buffer.concat([buildHeader(HEADER_SIZE + 4 + (showName.length + 1) * 2, 'CAEX'), w32(CAEX.EnterShow), ucs2(showName)]);
          c.write(es);
        } else if (m.length === 24 && m.readUInt32LE(20) === CAEX.FixtureListRequest) c.write(buildPatchMessage(fixtures));
      }
    });
    c.on('error', () => {});
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, received, port: server.address().port })));
}
