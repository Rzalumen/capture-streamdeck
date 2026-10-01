import test from 'node:test';
import assert from 'node:assert/strict';
import { lpEncode } from '../lib/c2z.mjs';
import { ambiguityNote, loadChannels, mapAttributes, parseModeBlock, tokens } from '../lib/modes.mjs';
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

// ---- Handoff 13: ambiguity that does not touch the driven channels ----
// Reza's Rogue R2X Wash ("56 Channel Rev.1"): two consistent sequences, identical in 0..54, differing only at the last offset
// ("Control" vs "Pan/Tilt Speed"). Reproduced small: the final record's tail holds a second, valid-looking record string.
const asRecord = (name, role = 0, pair = 0xffff) => Buffer.concat([lpEncode(name), Buffer.from([role]), Buffer.from([pair & 255, pair >> 8])]);
const rogueLike = (lastTail) => [
  { name: 'Pan', role: 1, pair: 1, tail: decoyTail }, { name: 'Pan Fine', role: 2, pair: 0, tail: decoyTail },
  { name: 'Tilt', role: 1, pair: 3, tail: decoyTail }, { name: 'Tilt Fine', role: 2, pair: 2, tail: decoyTail },
  { name: 'Pan/Tilt Speed', tail: decoyTail }, { name: 'Dimmer', tail: decoyTail }, { name: 'Dimmer Fine', role: 0, tail: decoyTail },
  { name: 'Shutter', tail: decoyTail }, { name: 'Red 1', tail: decoyTail }, { name: 'Zoom', tail: decoyTail },
  { name: 'Control', tail: lastTail },
];

test('ambiguity: a valid-looking record string inside the final record\'s tail -> candidates agree on every driven channel -> proceeds with the first (file-order) candidate', () => {
  const obj = buildObject(buildModeBlock({ guid: MODE, channels: rogueLike(Buffer.concat([Buffer.from([9, 9]), asRecord('Pan/Tilt Speed'), Buffer.alloc(6, 0xcc)])) }));
  // the parser itself still reports the ambiguity (ok:false) and lists both candidates
  const raw = parseModeBlock(obj, MODE);
  assert.equal(raw.ok, false);
  assert.equal(raw.ambiguous, true);
  assert.equal(raw.candidates.length, 2);
  assert.match(raw.error, /more than one consistent .*differ at offsets \[10\] \(10: "Control" vs "Pan\/Tilt Speed"\)/);
  // the gate proceeds
  const r = loadChannels(obj, MODE, 11);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.channels.length, 11);
  assert.equal(r.channels[10].name, 'Control', 'first candidate = earliest in the file');
  assert.deepEqual(r.ambiguity.differOffsets, [10]);
  assert.equal(r.ambiguity.candidates.length, 2);
  assert.match(ambiguityNote(r.ambiguity.candidates, r.ambiguity.differOffsets), /^2 candidate channel lists differ only at offsets \[10\] \(not used by this test\): 10: "Control" vs "Pan\/Tilt Speed"$/);
  // right mapping: pan/tilt 16-bit, "Pan/Tilt Speed" is not pan, dimmer and shutter found
  const m = mapAttributes(r.channels).map;
  assert.deepEqual([m.pan.coarse.offset, m.pan.fine.offset, m.tilt.coarse.offset, m.tilt.fine.offset, m.intensity.coarse.offset, m.shutter.coarse.offset], [0, 1, 2, 3, 5, 7]);
  // driven offsets never include a differing one
  assert.deepEqual(r.ambiguity.drivenOffsets, [0, 1, 2, 3, 5, 7]);
  // the final-record-only comparison is disclosed
  assert.match(r.block.warnings.join('\n'), /compared for the final channel record only/);
  // the channel-count checks still apply to the resolved list
  assert.equal(loadChannels(obj, MODE, 12).ok, false);
  assert.match(loadChannels(obj, MODE, 12).error, /ChannelCount=12/);
});

test('ambiguity: three candidates (two decoys) agreeing on the driven channels proceed; the same name in its own tail is not an ambiguity; 40 decoys still proceed', () => {
  const tail = Buffer.concat([asRecord('Reset'), Buffer.from([1]), asRecord('Lamp Off'), Buffer.alloc(4, 0xcc)]);
  const r = loadChannels(buildObject(buildModeBlock({ guid: MODE, channels: rogueLike(tail) })), MODE, 11);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.ambiguity.candidates.length, 3);
  assert.deepEqual(r.ambiguity.differOffsets, [10]);
  assert.equal(r.channels[10].name, 'Control');
  const same = loadChannels(buildObject(buildModeBlock({ guid: MODE, channels: rogueLike(Buffer.concat([asRecord('Control'), Buffer.alloc(3)])) })), MODE, 11);
  assert.equal(same.ok, true, same.error);
  assert.equal(same.ambiguity, null, 'identical channel lists found at two byte positions are one candidate');
  const many = Buffer.concat([Buffer.from([7]), ...Array.from({ length: 40 }, (_, i) => asRecord(`Decoy ${i}`)), Buffer.alloc(4, 0xcc)]);
  const m = loadChannels(buildObject(buildModeBlock({ guid: MODE, channels: rogueLike(many) })), MODE, 11);
  assert.equal(m.ok, true, m.error);
  assert.equal(m.ambiguity.candidates.length, 41);
  assert.deepEqual(m.ambiguity.differOffsets, [10]);
});

test('ambiguity: candidates that DIFFER on a driven channel still refuse (pan missing in one, same offset but another name, pan at another offset)', () => {
  // real last record "Control", decoy "Pan" in its tail; the real list has NO pan at all, the decoy list has one -> disagree on pan
  const noPan = [
    { name: 'Tilt', tail: decoyTail }, { name: 'Dimmer', tail: decoyTail }, { name: 'Shutter', tail: decoyTail },
    { name: 'Control', tail: Buffer.concat([Buffer.from([5]), asRecord('Pan'), Buffer.alloc(4, 0xcc)]) },
  ];
  const obj = buildObject(buildModeBlock({ guid: MODE, channels: noPan }));
  assert.equal(parseModeBlock(obj, MODE).ambiguous, true);
  const r = loadChannels(obj, MODE, 4);
  assert.equal(r.ok, false);
  assert.match(r.error, /disagree on a channel that would be driven: pan: not found vs offset 3 "Pan"/);
  assert.deepEqual(r.ambiguity.disagree, ['pan']);
  // pan at the same (last) offset but under another name -> still a disagreement (names must match too)
  const sameOffset = [
    { name: 'Dimmer', tail: decoyTail }, { name: 'Pan Speed', tail: decoyTail }, { name: 'Tilt', tail: decoyTail },
    { name: 'Pan', tail: Buffer.concat([Buffer.from([5]), asRecord('Pan 2'), Buffer.alloc(4, 0xcc)]) },
  ];
  const so = loadChannels(buildObject(buildModeBlock({ guid: MODE, channels: sameOffset })), MODE, 4);
  assert.equal(so.ok, false);
  assert.match(so.error, /pan: offset 3 "Pan" vs offset 3 "Pan 2"/);
  // a decoy "Pan" inside the tail of record 1 (not the final record): the readings disagree on what is driven
  const differ = [
    { name: 'Dimmer', tail: decoyTail },
    { name: 'Aux 1', tail: Buffer.concat([Buffer.from([5]), asRecord('Pan'), Buffer.alloc(4, 0xcc)]) },
    { name: 'Tilt', tail: decoyTail }, { name: 'Shutter', tail: decoyTail },
  ];
  const d = loadChannels(buildObject(buildModeBlock({ guid: MODE, channels: differ })), MODE, 4);
  assert.equal(d.ok, false, 'driven channels differ between candidates');
  assert.match(d.error, /disagree on a channel that would be driven/);
  // pan at a different offset in the two readings of the final record: real "Pan" is last, the decoy list has a "Pan" earlier? -> an earlier real Pan wins in both: agrees
  const agree = loadChannels(buildObject(buildModeBlock({ guid: MODE, channels: [{ name: 'Dimmer', tail: decoyTail }, { name: 'Pan', tail: decoyTail }, { name: 'Tilt', tail: decoyTail }, { name: 'Control', tail: Buffer.concat([asRecord('Pan'), Buffer.alloc(4)]) }] })), MODE, 4);
  assert.equal(agree.ok, true, agree.error);
});

test('ambiguity: the other reading of the final record is the first record of the NEXT mode block -> outside this block -> ignored, unique result', () => {
  const b1 = buildModeBlock({ guid: MODE, channels: rogueLike(Buffer.alloc(0)) });
  const b2 = buildModeBlock({ guid: OTHER, name: 'Other', channels: [{ name: 'Pan/Tilt Speed' }, { name: 'Pan', role: 1, pair: 3 }, { name: 'Dimmer' }, { name: 'Pan Fine', role: 2, pair: 1 }] });
  const obj = buildObject(b1, b2);
  const r = parseModeBlock(obj, MODE);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.channels.length, 11);
  assert.equal(r.channels[10].name, 'Control');
  assert.match(r.warnings.join('\n'), /other reading\(s\) of the final channel record lie at or beyond byte \d+, where the next mode block starts/);
  assert.equal(loadChannels(obj, MODE, 11).ok, true);
  assert.equal(loadChannels(obj, MODE, 11).ambiguity, null);
  // and the second block still parses on its own
  assert.equal(parseModeBlock(obj, OTHER).ok, true);
  // without a next block header the same bytes are an in-block ambiguity (compared, and here they agree)
  const alone = loadChannels(buildObject(Buffer.concat([b1, asRecord('Pan/Tilt Speed')])), MODE, 11);
  assert.equal(alone.ok, true, alone.error);
  assert.equal(alone.ambiguity.candidates.length, 2);
});

test('ambiguity: more than 500 readings of the final record cannot all be compared -> refuse', () => {
  const tail = Buffer.concat([Buffer.from([7]), ...Array.from({ length: 520 }, (_, i) => asRecord(`Decoy ${i}`)), Buffer.alloc(4, 0xcc)]);
  const obj = buildObject(buildModeBlock({ guid: MODE, channels: rogueLike(tail) }));
  const raw = parseModeBlock(obj, MODE);
  assert.equal(raw.ambiguous, true); assert.equal(raw.candidatesTruncated, true);
  const r = loadChannels(obj, MODE, 11);
  assert.equal(r.ok, false);
  assert.match(r.error, /more than 500 candidate channel lists/);
});
