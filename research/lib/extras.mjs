// Extra channels held at a fixed value during dmx-proof (--set, --color-full). Generic: names and offsets come from the parsed
// channel list; no fixture type is known here.
import { tokens, NOT_THE_VALUE } from './modes.mjs';

/** Additive colour names (whole words, case-insensitive). "warm white" / "cool white" are covered by the word "white". */
const ADDITIVE = new Set(['red', 'green', 'blue', 'white', 'amber', 'lime', 'uv']);
/** Words that make a channel NEVER part of --color-full: subtractive colours (full = dark), correction / tint channels (full = tinted), strobe/shutter channels (full = strobing or closed). */
const NEVER = new Set(['cyan', 'magenta', 'yellow', 'cto', 'ctb', 'ctc', 'cmy', 'correction', 'corr', 'balance', 'minus', 'plus', 'tint', 'temperature', 'temp', 'strobe', 'shutter', 'flash']);

/** True when the channel NAME is an additive colour emitter: has an additive colour word and no never-word and no speed/mode/curve ... word. */
export function isAdditiveColourName(name) {
  const t = tokens(name);
  return t.some((w) => ADDITIVE.has(w)) && !t.some((w) => NEVER.has(w) || NOT_THE_VALUE.has(w));
}

/**
 * chans: parsed channel list; map: result of mapAttributes (its pan/tilt/intensity/shutter channels are driven by the test and are off limits);
 * sets: [{channel (1-based within the fixture), value}]; colorFull: boolean; ambiguousOffsets: offsets whose name differs between candidate lists.
 * Result: {ok, error?, extras: [{offset, channel, name, value, source}], notes[]}. An empty-extras result is ok.
 */
export function planExtras(chans, map, { sets = [], colorFull = false, ambiguousOffsets = [] } = {}) {
  const driven = new Map(); // offset -> what drives it
  for (const a of ['pan', 'tilt', 'intensity', 'shutter']) {
    const m = map[a];
    if (!m) continue;
    driven.set(m.coarse.offset, `${a} (${m.coarse.name})`);
    if (m.fine) driven.set(m.fine.offset, `${a} fine (${m.fine.name})`);
  }
  const amb = new Set(ambiguousOffsets);
  const out = new Map(); // offset -> extra
  const notes = [];
  const put = (offset, value, source) => { out.set(offset, { offset, channel: offset + 1, name: chans[offset].name, value, source }); };

  // --set first (explicit). A coarse channel also sets its fine partner to the same value; a fine channel sets only itself.
  for (const { channel, value } of sets) {
    const offset = channel - 1;
    if (!Number.isInteger(channel) || channel < 1 || channel > chans.length) {
      return { ok: false, error: `--set ${channel}=${value}: this fixture has channels 1..${chans.length}`, extras: [], notes };
    }
    const c = chans[offset];
    const group = [c];
    if (c.role === 1 && chans[c.pair]) group.push(chans[c.pair]);
    for (const g of group) {
      if (driven.has(g.offset)) return { ok: false, error: `--set ${channel}=${value}: channel ${g.offset + 1} "${g.name}" is driven by the test itself as ${driven.get(g.offset)}; refusing to override it (use --shutter-value for the shutter)`, extras: [], notes };
      if (amb.has(g.offset)) return { ok: false, error: `--set ${channel}=${value}: channel ${g.offset + 1} is one of the channels where the candidate channel lists disagree (see the NOTE above), so what it is is not certain; refusing`, extras: [], notes };
    }
    const prev = out.get(offset);
    if (prev && prev.value !== value) return { ok: false, error: `--set ${channel} is given twice with different values (${prev.value} and ${value})`, extras: [], notes };
    put(offset, value, '--set');
    if (group.length > 1) put(group[1].offset, value, `--set ${channel} (fine partner)`);
    else if (c.role === 2) notes.push(`--set ${channel}: "${c.name}" is a fine channel; only that byte is set (set its coarse channel ${c.pair + 1} to set both)`);
  }

  if (colorFull) {
    const hit = [];
    for (const c of chans) {
      if (c.role === 2 || !isAdditiveColourName(c.name)) continue;
      if (driven.has(c.offset) || amb.has(c.offset)) continue;
      const fine = c.role === 1 ? chans[c.pair] : null;
      if (fine && (driven.has(fine.offset) || amb.has(fine.offset))) continue;
      if (out.has(c.offset)) { notes.push(`--color-full: channel ${c.offset + 1} "${c.name}" was already given by --set (${out.get(c.offset).value}); --set wins`); continue; }
      put(c.offset, 255, '--color-full');
      if (fine && !out.has(fine.offset)) put(fine.offset, 255, `--color-full (fine partner of ${c.offset + 1})`);
      hit.push(c.offset + 1);
    }
    if (!hit.length) notes.push('--color-full: no additive colour channel (red, green, blue, white, amber, lime, uv) was found by name, so nothing was set');
  }
  return { ok: true, extras: [...out.values()].sort((a, b) => a.offset - b.offset), notes };
}
