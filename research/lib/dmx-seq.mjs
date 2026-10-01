// The dmx-proof move sequence and the mapping from attribute values to DMX slots. Generic: it only uses the channel
// offsets found by lib/modes.mjs (parsed from the fixture's own library object), never any fixture-specific number.

/** 8-bit channel: round(f*255). 16-bit pair: round(f*65535) split into coarse (high) and fine (low) byte. */
export function setAttr(slots, base, entry, fraction, { raw8 = null } = {}) {
  const f = Math.min(1, Math.max(0, fraction));
  if (raw8 !== null) { slots[base + entry.coarse.offset] = raw8 & 0xff; if (entry.fine) slots[base + entry.fine.offset] = 0; return; }
  if (entry.fine) {
    const v = Math.round(f * 65535);
    slots[base + entry.coarse.offset] = v >> 8;
    slots[base + entry.fine.offset] = v & 0xff;
  } else slots[base + entry.coarse.offset] = Math.round(f * 255);
}

/**
 * The sequence: hold, then pan (glide 50% -> 0%, then sweep 0 -> 100 -> 50% taking `sweepSeconds`), then the same for tilt.
 * Speed is constant within a sweep (0->100 takes 2/3 of the time, 100->50 the last 1/3) and the glide uses that same speed.
 */
export function buildTimeline({ holdSeconds = 1, sweepSeconds = 6 } = {}) {
  const glide = sweepSeconds / 3;
  const phases = [];
  let t = 0;
  const add = (name, dur, axis, fn) => { phases.push({ name, start: t, end: t + dur, axis, fn }); t += dur; };
  add('hold', holdSeconds, null, () => 0.5);
  for (const axis of ['pan', 'tilt']) {
    add(`${axis} glide 50% -> 0%`, glide, axis, (u) => 0.5 * (1 - u));
    add(`${axis} sweep 0% -> 100% -> 50%`, sweepSeconds, axis, (u) => (u < 2 / 3 ? u * 1.5 : 1 - (u - 2 / 3) * 1.5 * 0.5));
  }
  return { phases, total: t };
}

/** Pan/tilt fractions at time `t` seconds. Past the end the last values are held. */
export function stateAt(timeline, t) {
  const st = { pan: 0.5, tilt: 0.5, phase: timeline.phases[0].name };
  for (const p of timeline.phases) {
    if (t < p.start) break;
    const u = p.end > p.start ? Math.min(1, (t - p.start) / (p.end - p.start)) : 1;
    st.phase = p.name;
    if (p.axis) {
      st[p.axis] = p.fn(u);
      if (p.axis === 'pan') st.tilt = 0.5; // tilt stays centred while pan moves
      else st.pan = 0.5;
    } else { st.pan = 0.5; st.tilt = 0.5; }
  }
  return st;
}

/** All 512 slots for one frame: everything 0 except this fixture's mapped attributes. */
export function frameSlots({ map, base, shutterRaw, pan, tilt, intensity = 1 }) {
  const slots = new Uint8Array(512);
  if (map.intensity) setAttr(slots, base, map.intensity, intensity);
  if (map.shutter) setAttr(slots, base, map.shutter, 1, { raw8: shutterRaw });
  setAttr(slots, base, map.pan, pan);
  setAttr(slots, base, map.tilt, tilt);
  return slots;
}
