import test from 'node:test';
import assert from 'node:assert/strict';
import { lpEncode } from '../lib/c2z.mjs';
import { loadChannels, mapAttributes, parseModeBlock, tokens } from '../lib/modes.mjs';
import { buildModeBlock, buildObject, decoyTail, prng, sampleChannels } from './synth-modes.mjs';

const MODE = '9d6629e3-872b-4a74-a935-6675826f4313';
const OTHER = '0691aaec-1491-40a2-b5c3-8942bb4d2402';
const summary = (chs) => chs.map((c) => [c.offset, c.name, c.role, c.pair]);

test('mode block: exact channel count with decoy strings inside every record', () => {
  const chans = sampleChannels(decoyTail);
  const obj = buildObject(buildModeBlock({ guid: MODE, channels: chans }));
  const r = parseModeBlock(obj, MODE);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.encoding, 'COM mixed-endian');
  assert.equal(r.channelCount, 8);
  assert.deepEqual(summary(r.channels), [
    [0, 'Pan', 1, 1], [1, 'Pan Fine', 2, 0], [2, 'Tilt', 1, 3], [3, 'Tilt Fine', 2, 2],
    [4, 'Beam Dimmer', 0, 0xffff], [5, 'Shutter', 0, 0xffff], [6, 'Color Wheel', 0, 0xffff], [7, 'Gobo Wheel', 0, 0xffff],
  ]);
  assert.equal(r.name, 'Standard');
  assert.deepEqual(r.props, [{ key: 'Key', type: 3, value: 'Value' }]);
});

test('mode block: decoys that LOOK like records (valid name, valid role) but are inconsistent are skipped', () => {
  // decoy 1: "Pan" + role 1 pointing at offset 6 whose record does not point back; decoy 2: a 16-bit decoy with a bad partner
  const tail = (i) => Buffer.concat([
    Buffer.from([1, 2, 3]), lpEncode('Decoy A'), Buffer.from([1, 6, 0]),
    lpEncode('Decoy B'), Buffer.from([2, 0xfe, 0x00]),
    lpEncode('Decoy C'), Buffer.from([1, 0xff, 0xff]),   // role 1 with pair 0xFFFF: invalid
    lpEncode('Decoy D'), Buffer.from([0, 0x00, 0x00]),   // role 0 with pair 0: invalid
  ]);
  const obj = buildObject(buildModeBlock({ guid: MODE, channels: sampleChannels(tail) }));
  const r = parseModeBlock(obj, MODE);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.channels.map((c) => c.name), ['Pan', 'Pan Fine', 'Tilt', 'Tilt Fine', 'Beam Dimmer', 'Shutter', 'Color Wheel', 'Gobo Wheel']);
});

test('mode block: seeded random tails of many sizes still give the exact count (or a safe refusal, never a wrong list)', () => {
  const rnd = prng(12345);
  let exact = 0, refused = 0;
  for (let n = 0; n < 60; n++) {
    const tail = () => Buffer.concat([
      Buffer.from(Array.from({ length: Math.floor(rnd() * 40) }, () => Math.floor(rnd() * 256))),
      rnd() < 0.5 ? lpEncode(['Open', 'Red', 'Spot 7', 'Rotate'][Math.floor(rnd() * 4)]) : Buffer.alloc(0),
      Buffer.from(Array.from({ length: Math.floor(rnd() * 12) }, () => Math.floor(rnd() * 256))),
    ]);
    const chans = sampleChannels(tail).map((c) => ({ ...c, tail: tail() }));
    const r = parseModeBlock(buildObject(buildModeBlock({ guid: MODE, channels: chans })), MODE);
    if (r.ok) {
      assert.deepEqual(r.channels.map((c) => c.name), chans.map((c) => c.name), `trial ${n}`);
      exact++;
    } else refused++; // ambiguity (random bytes can build a valid-looking record) is allowed, a wrong answer is not
  }
  assert.ok(exact >= 50, `only ${exact} of 60 parsed (refused ${refused})`);
});

test('mode block: raw-order GUID is accepted with a warning; a second mode block is not confused with the first', () => {
  const a = buildModeBlock({ guid: MODE, encoding: 'raw', name: 'A', channels: [{ name: 'Dimmer' }, { name: 'Pan', role: 1, pair: 2 }, { name: 'Tilt' }, { name: 'Pan Fine', role: 2, pair: 1 }].slice(0, 1) });
  const b = buildModeBlock({ guid: OTHER, name: 'B', channels: sampleChannels(decoyTail) });
  const obj = buildObject(a, b);
  const ra = parseModeBlock(obj, MODE);
  assert.equal(ra.ok, true, ra.error);
  assert.match(ra.warnings.join(' '), /RAW-order/);
  assert.deepEqual(ra.channels.map((c) => c.name), ['Dimmer']);
  const rb = parseModeBlock(obj, OTHER);
  assert.equal(rb.ok, true, rb.error);
  assert.equal(rb.name, 'B');
  assert.equal(rb.channels.length, 8);
});

test('mode block: refuses (does not guess) when the GUID is absent, the count is wrong, or the data is truncated', () => {
  const obj = buildObject(buildModeBlock({ guid: MODE, channels: sampleChannels(decoyTail) }));
  assert.equal(parseModeBlock(obj, OTHER).ok, false);
  assert.match(parseModeBlock(obj, OTHER).error, /not found/);
  // block claims 9 channels but 8 records exist (the 9th would have to come from the junk that follows)
  const over = buildObject(buildModeBlock({ guid: MODE, channels: sampleChannels(decoyTail), count: 9 }));
  const ro = parseModeBlock(over, MODE);
  assert.equal(ro.ok, false);
  assert.match(ro.error, /no consistent sequence of 9/);
  // block claims 7: records are parsed from the front, the 8th is simply not part of the block, but then the pair pointers of 7 records are inconsistent
  const under = buildObject(buildModeBlock({ guid: MODE, channels: sampleChannels(decoyTail), count: 7 }));
  const ru = parseModeBlock(under, MODE);
  if (ru.ok) assert.equal(ru.channels.length, 7); // acceptable only if it is exactly 7 records
  // truncated object
  const cut = obj.subarray(0, obj.indexOf(lpEncode('Tilt Fine')));
  assert.equal(parseModeBlock(cut, MODE).ok, false);
  // non-ASCII channel names are not decoded: safe refusal
  const na = buildObject(buildModeBlock({ guid: MODE, channels: [{ name: 'Dimmer' }, { name: Buffer.from('Façon', 'latin1').toString('latin1') }] }));
  assert.equal(parseModeBlock(na, MODE).ok, false);
});

test('abort on mismatch: loadChannels needs parsed == block channelCount == CAEX ChannelCount', () => {
  const obj = buildObject(buildModeBlock({ guid: MODE, channels: sampleChannels(decoyTail) }));
  assert.equal(loadChannels(obj, MODE, 8).ok, true);
  const bad = loadChannels(obj, MODE, 9);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /ChannelCount=9/);
  assert.equal(loadChannels(obj, MODE, 7).ok, false);
  assert.equal(loadChannels(obj, OTHER, 8).ok, false);
});

test('ambiguity is reported, not resolved: two different consistent record sequences -> ok:false', () => {
  // Record 0 "Dimmer" has a tail that contains a complete valid 8-bit record "Shutter"; the real record 1 is "Strobe".
  // Both [Dimmer, Shutter] and [Dimmer, Strobe] are consistent two-record sequences.
  const obj = buildObject(buildModeBlock({
    guid: MODE, count: 2,
    channels: [{ name: 'Dimmer', tail: Buffer.concat([lpEncode('Shutter'), Buffer.from([0, 0xff, 0xff])]) }, { name: 'Strobe' }],
  }));
  const r = parseModeBlock(obj, MODE);
  assert.equal(r.ok, false);
  assert.match(r.error, /more than one consistent/);
  assert.equal(loadChannels(obj, MODE, 2).ok, false);
});

// ---- attribute mapping ----
const ch = (...names) => names.map((name, offset) => ({ offset, name, role: 0, pair: 0xffff }));
const pairUp = (chs, coarse, fine) => { chs[coarse].role = 1; chs[coarse].pair = fine; chs[fine].role = 2; chs[fine].pair = coarse; return chs; };

test('attribute mapping across naming styles', () => {
  const styles = [
    { names: ['Pan', 'Pan Fine', 'Tilt', 'Tilt Fine', 'Dimmer', 'Shutter'], p: [0, 1], t: [2, 3], i: 4, s: 5 },
    { names: ['Pan Coarse', 'Pan Fine', 'Tilt Coarse', 'Tilt Fine', 'Intensity', 'Strobe'], p: [0, 1], t: [2, 3], i: 4, s: 5 },
    { names: ['PAN', 'TILT', 'BEAM DIMMER', 'SHUTTER/STROBE'], p: [0, null], t: [1, null], i: 2, s: 3 },
    { names: ['Beam Dimmer', 'Pan 16', 'Pan 16 Fine', 'tilt'], p: [1, 2], t: [3, null], i: 0, s: undefined },
    { names: ['Intensity', 'Pan', 'Tilt'], p: [1, null], t: [2, null], i: 0, s: undefined },
  ];
  for (const s of styles) {
    const chs = ch(...s.names);
    if (s.p[1] !== null) pairUp(chs, s.p[0], s.p[1]);
    if (s.t[1] !== null) pairUp(chs, s.t[0], s.t[1]);
    const m = mapAttributes(chs);
    assert.equal(m.map.pan?.coarse.offset, s.p[0], s.names.join(','));
    assert.equal(m.map.pan?.fine?.offset ?? null, s.p[1], s.names.join(','));
    assert.equal(m.map.tilt?.coarse.offset, s.t[0]);
    assert.equal(m.map.tilt?.fine?.offset ?? null, s.t[1]);
    assert.equal(m.map.intensity?.coarse.offset, s.i);
    assert.equal(m.map.shutter?.coarse.offset, s.s);
  }
});

test('attribute mapping: first match wins and others are listed; speed/mode channels are not the value; fine channels never chosen', () => {
  const chs = ch('Pan/Tilt Speed', 'Pan', 'Pan Fine', 'Tilt', 'Dimmer Curve', 'Dimmer', 'Intensity 2', 'Shutter Mode', 'Shutter');
  pairUp(chs, 1, 2);
  const m = mapAttributes(chs);
  assert.equal(m.map.pan.coarse.offset, 1);
  assert.equal(m.map.pan.fine.offset, 2);
  assert.equal(m.map.tilt.coarse.offset, 3);
  assert.equal(m.map.intensity.coarse.offset, 5);
  assert.deepEqual(m.map.intensity.others.map((c) => c.offset), [6]);
  assert.match(m.warnings.join('\n'), /intensity: several channels match/);
  assert.equal(m.map.shutter.coarse.offset, 8);
  // pan/tilt missing -> reported
  const none = mapAttributes(ch('Dimmer', 'Zoom', 'Pan/Tilt Speed'));
  assert.deepEqual(none.missing.sort(), ['pan', 'shutter', 'tilt']);
  assert.match(none.warnings.join('\n'), /pan: only channel/);
  assert.deepEqual(tokens('PanFine'), ['pan', 'fine']);
});
