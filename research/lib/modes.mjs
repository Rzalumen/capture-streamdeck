// DMX-mode block parser for Capture library objects (.c2o) and generic attribute mapping by channel name.
//
// NOTHING here knows any fixture type: it works from the bytes of the object and the channel names it finds.
//
// VERIFIED FACTS this builds on (handoff 11, from mode-probe on real objects):
//  * The AtlaBaseModeId's raw-order GUID string appears in the object in COM mixed-endian byte encoding.
//  * The block starts at that GUID:
//      [16-byte GUID][u32 len+1, name][u32 propCount]{u32 len+1 key, u32 type, u32 len+1 value}*propCount
//      [u32 channelCount]{channel record}*channelCount
//    (string = u32 length that is BYTES + 1, no terminator, as in Index.c2t.)
//  * A channel record starts with its name (such a string) followed by u8 role and u16 pair (little endian):
//      role 0 = 8-bit (pair 0xFFFF); role 1 = coarse (pair = 0-based offset of its fine channel);
//      role 2 = fine (pair = offset of its coarse channel).
//    The rest of a record is NOT decoded, so its length is unknown. Records can hold other strings (wheel slot names ...),
//    so a channel name is "a string followed by a valid role/pair", and the sequence of records is chosen so that
//    (a) record 0 begins right after channelCount, (b) records do not overlap and keep file order, (c) pair pointers are
//    mutually consistent by channel offset (the k-th record IS channel offset k), (d) exactly channelCount records.
//    If more than one such sequence exists the parse is reported ambiguous and callers must not send DMX.

export const ROLE_NAMES = ['8-bit', 'coarse', 'fine'];
const MAX_NAME = 64;
const MAX_PROPS = 512;
const MAX_CHANNELS = 512;
const MAX_GAP = 16384; // bytes searched for the next record after the previous record's role/pair
const NODE_BUDGET = 300000;

const isAscii = (c) => c >= 0x20 && c <= 0x7e;

/** Raw-order GUID string -> its 16 bytes in raw order. */
export const rawGuidBytes = (g) => Buffer.from(g.replace(/-/g, ''), 'hex');
/** Raw-order GUID string -> its 16 bytes in COM mixed-endian encoding (first three groups byte-swapped). */
export function comGuidBytes(g) {
  const b = rawGuidBytes(g);
  b.subarray(0, 4).reverse(); b.subarray(4, 6).reverse(); b.subarray(6, 8).reverse();
  return b;
}

/** u32 len = bytes + 1, then the bytes. `allowEmpty` accepts len 1 (empty string). Returns {s, end} or null. */
function lp(buf, pos, { max = 200, allowEmpty = false, ascii = true } = {}) {
  if (pos < 0 || pos + 4 > buf.length) return null;
  const len = buf.readUInt32LE(pos);
  const n = len - 1;
  if (len < 1 || n > max || (n === 0 && !allowEmpty) || pos + 4 + n > buf.length) return null;
  for (let i = 0; i < n; i++) if (ascii && !isAscii(buf[pos + 4 + i])) return null;
  return { s: buf.toString('latin1', pos + 4, pos + 4 + n), end: pos + 4 + n };
}

/** A channel-record head at `pos`: name string then u8 role, u16 pair; null unless role/pair are structurally valid. */
function recordHead(buf, pos, count) {
  const nm = lp(buf, pos, { max: MAX_NAME });
  if (!nm || nm.end + 3 > buf.length) return null;
  const role = buf[nm.end];
  const pair = buf.readUInt16LE(nm.end + 1);
  if (role > 2) return null;
  if (role === 0 ? pair !== 0xffff : pair >= count) return null;
  return { name: nm.s, role, pair, start: pos, end: nm.end + 3 };
}

/** Enumerate every consistent sequence of `count` records beginning exactly at `start` (at most `limit` of them). */
function findRecordSequences(buf, start, count, limit = 2) {
  const solutions = [];
  const chosen = [];
  const expect = new Map(); // channel offset -> {role, pair} demanded by an earlier record that points forward
  let nodes = 0, exhausted = false;

  function accept(i, h) {
    const want = expect.get(i);
    if (want) return want.role === h.role && want.pair === h.pair;
    if (h.role === 0) return true;
    if (h.pair === i) return false;
    if (h.pair < i) {
      const other = chosen[h.pair];
      return other.role === (h.role === 1 ? 2 : 1) && other.pair === i;
    }
    return !expect.has(h.pair); // forward pointer: somebody else may not already expect that slot
  }

  function place(i, from) {
    if (solutions.length >= limit || exhausted) return;
    if (i === count) { solutions.push(chosen.map((c) => ({ ...c }))); return; }
    const last = i === 0 ? from : Math.min(buf.length - 4, from + MAX_GAP);
    for (let q = from; q <= last; q++) {
      if (++nodes > NODE_BUDGET) { exhausted = true; return; }
      const h = recordHead(buf, q, count);
      if (!h || !accept(i, h)) { if (i === 0) return; continue; }
      const had = expect.get(i);
      if (had) expect.delete(i);
      let set = false;
      if (!had && h.role !== 0 && h.pair > i) { expect.set(h.pair, { role: h.role === 1 ? 2 : 1, pair: i }); set = true; }
      chosen[i] = { offset: i, name: h.name, role: h.role, pair: h.pair, at: h.start, end: h.end };
      place(i + 1, h.end);
      chosen.length = i;
      if (set) expect.delete(h.pair);
      if (had) expect.set(i, had);
      if (solutions.length >= limit || exhausted) return;
    }
  }
  place(0, start);
  return { solutions, exhausted, nodes };
}

function sameChannels(a, b) {
  return a.length === b.length && a.every((c, i) => c.name === b[i].name && c.role === b[i].role && c.pair === b[i].pair);
}

/** Try to read a mode block whose GUID starts at `at`. Returns {ok, ...} with `error` when the structure doesn't parse. */
function parseBlockAt(obj, at) {
  const r = { ok: false, at, error: '' };
  let p = at + 16;
  const name = lp(obj, p, { max: 200, allowEmpty: true });
  if (!name) return { ...r, error: 'no valid mode name after the GUID' };
  r.name = name.s; p = name.end;
  if (p + 4 > obj.length) return { ...r, error: 'object ends before the property count' };
  const propCount = obj.readUInt32LE(p); p += 4;
  if (propCount > MAX_PROPS) return { ...r, error: `implausible property count ${propCount}` };
  r.props = [];
  for (let i = 0; i < propCount; i++) {
    const k = lp(obj, p, { max: 200, allowEmpty: true, ascii: false });
    if (!k || k.end + 4 > obj.length) return { ...r, error: `property ${i}: bad key` };
    const type = obj.readUInt32LE(k.end);
    const v = lp(obj, k.end + 4, { max: 4000, allowEmpty: true, ascii: false });
    if (!v) return { ...r, error: `property ${i} (${JSON.stringify(k.s)}): bad value` };
    r.props.push({ key: k.s, type, value: v.s }); p = v.end;
  }
  if (p + 4 > obj.length) return { ...r, error: 'object ends before the channel count' };
  r.channelCount = obj.readUInt32LE(p); p += 4;
  if (r.channelCount < 1 || r.channelCount > MAX_CHANNELS) return { ...r, error: `implausible channel count ${r.channelCount}` };
  r.recordsAt = p;
  const { solutions, exhausted, nodes } = findRecordSequences(obj, p, r.channelCount);
  r.nodes = nodes; r.searchExhausted = exhausted;
  if (!solutions.length) return { ...r, error: `no consistent sequence of ${r.channelCount} channel records starts at ${p}${exhausted ? ' (search budget used up)' : ''}` };
  r.channels = solutions[0].map(({ offset, name: n, role, pair }) => ({ offset, name: n, role, pair }));
  r.ambiguous = solutions.length > 1 && !sameChannels(solutions[0], solutions[1]);
  if (r.ambiguous) r.alternative = solutions[1].map(({ offset, name: n, role, pair }) => ({ offset, name: n, role, pair }));
  r.ok = true;
  return r;
}

/**
 * Find and parse the DMX-mode block of `modeRawGuid` (raw-order string) in a library object.
 * Result: {ok, encoding, blockAt, name, props, channelCount, channels[], warnings[], error?}
 * ok is false when the GUID is absent, no hit parses, or the parse is ambiguous (see `error`).
 */
export function parseModeBlock(obj, modeRawGuid) {
  const warnings = [];
  const tried = [];
  const encodings = [['COM mixed-endian', comGuidBytes(modeRawGuid)], ['raw order', rawGuidBytes(modeRawGuid)]];
  for (const [encoding, pat] of encodings) {
    const hits = [];
    for (let from = 0; ;) { const at = obj.indexOf(pat, from); if (at < 0) break; hits.push(at); from = at + 1; }
    if (!hits.length) { tried.push(`${encoding}: no occurrence`); continue; }
    const parsed = hits.map((at) => parseBlockAt(obj, at));
    const good = parsed.filter((x) => x.ok);
    if (!good.length) { tried.push(`${encoding}: ${hits.length} occurrence(s), none parse as a block (${parsed.map((x) => `@${x.at}: ${x.error}`).join('; ')})`); continue; }
    const first = good[0];
    if (good.length > 1 && !good.every((g) => sameChannels(g.channels, first.channels))) {
      return { ok: false, error: `the mode GUID parses as a block at ${good.length} places with different channel lists (${good.map((g) => '@' + g.at).join(', ')})`, warnings };
    }
    if (good.length > 1) warnings.push(`mode GUID occurs ${good.length} times with identical channel lists (${good.map((g) => '@' + g.at).join(', ')})`);
    if (encoding !== 'COM mixed-endian') warnings.push(`the block was found by the RAW-order GUID, not the verified mixed-endian one`);
    if (first.ambiguous) return { ...first, ok: false, error: 'more than one consistent channel-record sequence exists: ' + describe(first.channels) + '  vs  ' + describe(first.alternative), warnings };
    if (first.searchExhausted) warnings.push('search budget used up while checking for alternative parses; the parse found is consistent but uniqueness is not proven');
    return { ok: true, encoding, blockAt: first.at, name: first.name, props: first.props, channelCount: first.channelCount, channels: first.channels, warnings };
  }
  return { ok: false, error: `mode block not found: ${tried.join(' | ')}`, warnings };
}

const describe = (chs) => chs.map((c) => `${c.offset}:${c.name}`).join(', ');

// ---------------------------------------------------------------- attribute mapping by name

/** Lower-case word tokens of a channel name; camelCase is split ("PanFine" -> pan fine). */
export function tokens(name) {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
/** Channels that are about a different thing even if the word matches ("Pan/Tilt Speed", "Dimmer Curve", "Shutter Mode"). */
const NOT_THE_VALUE = new Set(['speed', 'time', 'macro', 'reset', 'mode', 'control', 'ctrl', 'rate', 'curve', 'function', 'func', 'response', 'duration', 'invert', 'reverse', 'inverse']);

const MATCHERS = {
  pan: (t) => t === 'pan',
  tilt: (t) => t === 'tilt',
  intensity: (t) => t.startsWith('dimmer') || t.startsWith('intensity'),
  shutter: (t) => t.startsWith('shutter') || t.startsWith('strobe'),
};

/**
 * Generic attribute mapping by name, case-insensitive:
 *   pan = a name containing the word "pan"; tilt = "tilt"; intensity = "dimmer" or "intensity"; shutter = "shutter" or "strobe".
 * Only 8-bit and coarse channels are candidates (a fine channel is the partner of its coarse one). Channels whose name also has a
 * speed/time/mode/curve ... word are not the value channel and are skipped. A channel serves one attribute only. If several
 * match, the first is taken and the rest are listed in `others`.
 * Result: {map: {pan?, tilt?, intensity?, shutter?}, missing[], warnings[]}; each entry {coarse, fine|null, others[]}.
 */
export function mapAttributes(channels) {
  const map = {}, missing = [], warnings = [], used = new Set();
  for (const attr of ['pan', 'tilt', 'intensity', 'shutter']) {
    const m = MATCHERS[attr];
    const cands = channels.filter((c) => c.role !== 2 && !used.has(c.offset) && tokens(c.name).some(m));
    const good = cands.filter((c) => !tokens(c.name).some((t) => NOT_THE_VALUE.has(t)));
    if (!good.length) {
      missing.push(attr);
      if (cands.length) warnings.push(`${attr}: only channel(s) that look like speed/mode/curve controls matched: ${cands.map((c) => `${c.offset} "${c.name}"`).join(', ')}`);
      continue;
    }
    const [coarse, ...others] = good;
    used.add(coarse.offset);
    const fine = coarse.role === 1 ? channels[coarse.pair] ?? null : null;
    map[attr] = { coarse, fine, others };
    if (fine) used.add(fine.offset);
    if (others.length) warnings.push(`${attr}: several channels match; using ${coarse.offset} "${coarse.name}", ignoring ${others.map((c) => `${c.offset} "${c.name}"`).join(', ')}`);
  }
  return { map, missing, warnings };
}

/**
 * The gate dmx-proof passes before it may send anything: the mode block must parse uniquely AND the parsed channel count must
 * equal both the count stored in the block and the ChannelCount Capture reported for the fixture (CAEX FixtureList).
 * Result: {ok, channels?, block, error?}.
 */
export function loadChannels(obj, modeRawGuid, caexChannelCount) {
  const block = parseModeBlock(obj, modeRawGuid);
  if (!block.ok) return { ok: false, block, error: block.error };
  const n = block.channels.length;
  if (n !== block.channelCount) return { ok: false, block, error: `parsed ${n} channel(s) but the mode block says channelCount=${block.channelCount}` };
  if (n !== caexChannelCount) return { ok: false, block, error: `mode block has ${n} channel(s) but Capture's patch says ChannelCount=${caexChannelCount} for this fixture` };
  return { ok: true, block, channels: block.channels };
}
