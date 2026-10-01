import test from 'node:test';
import assert from 'node:assert/strict';
import { isAdditiveColourName, planExtras } from '../lib/extras.mjs';
import { mapAttributes } from '../lib/modes.mjs';

// a made-up RGBW-ish moving light; 1-based channel numbers are offset + 1
export const NAMES = [
  ['Pan', 1, 1], ['Pan Fine', 2, 0], ['Tilt', 1, 3], ['Tilt Fine', 2, 2], ['Pan/Tilt Speed'], ['Dimmer'], ['Shutter'],
  ['Red 1', 1, 8], ['Red 1 Fine', 2, 7], ['Green 1'], ['Blue 1'], ['White 1'],
  ['Cyan'], ['Magenta'], ['Yellow'], ['CTO'], ['CTB'], ['Warm White'], ['Cool White'], ['Amber'], ['Lime'], ['UV'],
  ['Color Wheel'], ['Green Correction'], ['White Balance'], ['Red Strobe'], ['Red Speed'], ['Control'],
];
export const chans = NAMES.map(([name, role = 0, pair = 0xffff], offset) => ({ offset, name, role, pair }));
const ch = (name) => chans.find((c) => c.name === name).offset + 1;
const { map } = mapAttributes(chans);

test('color-full: names are matched as whole words, additive only', () => {
  for (const n of ['Red 1', 'Green', 'BLUE', 'White 1', 'Amber', 'Lime', 'UV', 'Warm White', 'Cool White', 'Red/Green/Blue']) assert.equal(isAdditiveColourName(n), true, n);
  for (const n of ['Cyan', 'Magenta', 'Yellow', 'CTO', 'CTB', 'Cyan Red', 'Yellow Fine', 'Color Wheel', 'Redirect', 'Whiteout', 'Green Correction', 'White Balance', 'Red Strobe', 'Red Speed', 'Magenta/Green', 'Dimmer']) assert.equal(isAdditiveColourName(n), false, n);
});

test('color-full sets exactly the additive coarse/8-bit channels at 255, the fine partner too, and never the subtractive/correction ones', () => {
  const r = planExtras(chans, map, { colorFull: true });
  assert.equal(r.ok, true);
  const names = r.extras.map((e) => e.name);
  assert.deepEqual(names, ['Red 1', 'Red 1 Fine', 'Green 1', 'Blue 1', 'White 1', 'Warm White', 'Cool White', 'Amber', 'Lime', 'UV']);
  assert.ok(r.extras.every((e) => e.value === 255));
  for (const never of ['Cyan', 'Magenta', 'Yellow', 'CTO', 'CTB', 'Color Wheel', 'Green Correction', 'White Balance', 'Red Strobe', 'Red Speed', 'Control']) assert.ok(!names.includes(never), never);
  assert.equal(r.extras.find((e) => e.name === 'Red 1 Fine').source, '--color-full (fine partner of 8)');
  // driven channels are never touched
  for (const driven of ['Pan', 'Pan Fine', 'Tilt', 'Tilt Fine', 'Dimmer', 'Shutter']) assert.ok(!names.includes(driven));
});

test('--set maps the 1-based channel number to the offset; a coarse channel brings its fine partner, a fine channel is only itself', () => {
  const r = planExtras(chans, map, { sets: [{ channel: ch('White 1'), value: 200 }, { channel: ch('Red 1'), value: 7 }, { channel: ch('Magenta'), value: 0 }] });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.extras.map((e) => [e.channel, e.offset, e.name, e.value]), [[8, 7, 'Red 1', 7], [9, 8, 'Red 1 Fine', 7], [12, 11, 'White 1', 200], [14, 13, 'Magenta', 0]]);
  const fine = planExtras(chans, map, { sets: [{ channel: 9, value: 5 }] });
  assert.deepEqual(fine.extras.map((e) => e.channel), [9]);
  assert.match(fine.notes.join(), /fine channel; only that byte/);
});

test('--set refuses: out of range, a channel the test drives, a differing duplicate; --set wins over --color-full', () => {
  assert.match(planExtras(chans, map, { sets: [{ channel: 29, value: 1 }] }).error, /channels 1\.\.28/);
  assert.match(planExtras(chans, map, { sets: [{ channel: 1, value: 1 }] }).error, /driven by the test itself as pan/);
  assert.match(planExtras(chans, map, { sets: [{ channel: 2, value: 1 }] }).error, /pan fine/);
  assert.match(planExtras(chans, map, { sets: [{ channel: 6, value: 1 }] }).error, /intensity/);
  assert.match(planExtras(chans, map, { sets: [{ channel: 7, value: 1 }] }).error, /--shutter-value/);
  assert.match(planExtras(chans, map, { sets: [{ channel: 12, value: 1 }, { channel: 12, value: 2 }] }).error, /twice with different values/);
  const both = planExtras(chans, map, { sets: [{ channel: 12, value: 10 }], colorFull: true });
  assert.equal(both.extras.find((e) => e.channel === 12).value, 10);
  assert.match(both.notes.join(), /already given by --set \(10\)/);
});

test('channels where the candidate lists disagree are never set; --color-full with no colour channel is a note, not an error', () => {
  const amb = planExtras(chans, map, { sets: [{ channel: 12, value: 1 }], ambiguousOffsets: [11] });
  assert.match(amb.error, /candidate channel lists disagree/);
  const skip = planExtras(chans, map, { colorFull: true, ambiguousOffsets: [11] });
  assert.ok(!skip.extras.some((e) => e.name === 'White 1'));
  const plain = chans.slice(0, 7);
  const none = planExtras(plain, mapAttributes(plain).map, { colorFull: true });
  assert.equal(none.ok, true); assert.equal(none.extras.length, 0); assert.match(none.notes.join(), /no additive colour channel/);
});
