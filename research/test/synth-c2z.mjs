// Builds a small synthetic Library.c2z using the verified formats (Index.c2t strings: u32 LE = bytes + 1,
// no terminator). Test data only; contains no Capture content.
import zlib from 'node:zlib';
import { lpEncode } from '../lib/c2z.mjs';

const u16z = (s) => Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.from([0, 0])]);

export const GUIDS = {
  'VL3500 Spot': 'bcc93361-fc2a-4e06-8ddf-65ca480a84e7.c2o',
  'MAC Aura XB': '2f7c6351-e151-4c44-beca-80bb03902631.c2o',
};

function fixtureObject(attrs) {
  const parts = [Buffer.alloc(8)];
  for (const n of attrs) parts.push(Buffer.from([0, 0, 0]), Buffer.from(n, 'latin1'), Buffer.from([0, 0x40, 0x41]));
  const b = Buffer.concat(parts);
  b.writeUInt32LE(b.length, 0);
  b.writeUInt32LE(0x78c24e87, 4);
  return b;
}

const filler = (n) => Buffer.alloc(n, 0xab); // non-printable
const record = (p, mfr, model) => Buffer.concat([
  lpEncode(p), filler(91), lpEncode(mfr), lpEncode(model),
  Buffer.from('\x89PNG\r\n\x1a\n' + 'x'.repeat(700), 'latin1'),
]);

/** Returns {file: Buffer, guids}. Includes a _Symbols\ decoy carrying the same model name as MAC Aura XB. */
export function buildSyntheticLibrary() {
  const vector = Buffer.concat(['Bar', 'Ladder', 'Triangular', 'Folding', 'Rectangular'].map(lpEncode));
  const index = Buffer.concat([
    Buffer.alloc(12), vector,
    record('_LightingFixtures\\Vari-Lite\\Moving Heads\\' + GUIDS['VL3500 Spot'], 'Vari-Lite', 'VL3500 Spot'),
    record('_Symbols\\Martin\\Fixtures\\decoy.c2o', 'Martin', 'MAC Aura XB'),
    record('_LightingFixtures\\Martin\\Moving Heads\\' + GUIDS['MAC Aura XB'], 'Martin', 'MAC Aura XB'),
  ]);
  const objs = {
    [GUIDS['VL3500 Spot']]: fixtureObject(['Pan Coarse', 'Pan Fine', 'Tilt Coarse', 'Tilt Fine', 'Zoom', 'Dimmer', 'Pan Coarse']),
    [GUIDS['MAC Aura XB']]: fixtureObject(['Pan', 'Tilt', 'Zoom']),
  };
  const files = [['Index.c2t', index], ...Object.entries(objs)];
  let off = 0; const data = [], meta = [];
  for (const [n, b] of files) { const z = zlib.deflateSync(b); meta.push([n, off, b.length]); data.push(z); off += z.length; }
  const tree = Buffer.concat([Buffer.from('c2z '), Buffer.alloc(12), ...meta.map(([n, o, s]) => {
    const t = Buffer.alloc(8); t.writeUInt32LE(o); t.writeUInt32LE(s, 4); return Buffer.concat([u16z(n), t]);
  })]);
  return { file: Buffer.concat([zlib.deflateSync(tree), ...data]), guids: GUIDS };
}

// ---- mode-probe fixture: one object with two DMX modes ----
export const MODE_FIXTURE = '2f7c6351-e151-4c44-beca-80bb03902631';
export const MODE_A = '9d6629e3-872b-4a74-a935-6675826f4313'; // stored in raw byte order
export const MODE_B = '0691aaec-1491-40a2-b5c3-8942bb4d2402'; // stored in mixed-endian byte order

export function mixedEndian(rawGuid) {
  const b = Buffer.from(rawGuid.replace(/-/g, ''), 'hex');
  b.subarray(0, 4).reverse(); b.subarray(4, 6).reverse(); b.subarray(6, 8).reverse();
  return b;
}

/** Object: header, filler, [mode A guid raw][name "Standard"][Pan Tilt Dimmer], [mode B guid mixed][name "Extended"][6 attrs]. */
export function buildModeLibrary() {
  const raw = (g) => Buffer.from(g.replace(/-/g, ''), 'hex');
  const body = Buffer.concat([
    Buffer.alloc(8), filler(40),
    raw(MODE_A), lpEncode('Standard'), ...['Pan', 'Tilt', 'Dimmer'].map(lpEncode), filler(6),
    mixedEndian(MODE_B), lpEncode('Extended'), ...['Pan', 'Pan Fine', 'Tilt', 'Tilt Fine', 'Zoom', 'Dimmer'].map(lpEncode), filler(6),
  ]);
  body.writeUInt32LE(body.length, 0);
  body.writeUInt32LE(0x78c24e87, 4);
  const z = zlib.deflateSync(body);
  const tree = Buffer.concat([Buffer.from('c2z '), Buffer.alloc(12), u16z(`${MODE_FIXTURE}.c2o`), (() => { const t = Buffer.alloc(8); t.writeUInt32LE(0); t.writeUInt32LE(body.length, 4); return t; })()]);
  return { file: Buffer.concat([zlib.deflateSync(tree), z]), object: body };
}
