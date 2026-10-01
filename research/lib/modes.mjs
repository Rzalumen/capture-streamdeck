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
//    If more than one such sequence exists the parse is reported ambiguous (ok:false, `candidates`, in file order) and callers must
//    not send DMX unless resolveAmbiguity() shows the candidates agree on every channel they intend to drive.
//    Which alternatives are compared (handoff 13): when the first sequence has alternatives for the FINAL record only (the usual case:
//    another valid-looking record string in the final record's undecoded tail, or the first record of the next mode block), all
//    alternatives for that final record that lie before the next mode-block header are candidates; those at or beyond the header
//    are outside this block and are ignored (counted and reported). Alternatives that differ earlier than the final record are
//    only enumerated (strictly, up to CANDIDATE_LIMIT) when no final-record alternative exists.

export const ROLE_NAMES = ['8-bit', 'coarse', 'fine'];
const MAX_NAME = 64;
const MAX_PROPS = 512;
const MAX_CHANNELS = 512;
const MAX_GAP = 16384; // bytes searched for the next record after the previous record's role/pair
const NODE_BUDGET = 300000;
const CANDIDATE_LIMIT = 32; // consistent sequences collected; reaching it means the list is incomplete and callers must refuse
const FINAL_LIMIT = 500; // alternatives for the final record collected inside the block; reaching it means callers must refuse
const OUTSIDE_COUNT_LIMIT = 50; // alternatives beyond the next block header are only counted, up to this many

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

/**
 * Enumerate consistent sequences of `count` records (at most `limit`), depth-first, deepest variations first.
 * Default: record 0 begins exactly at `start`. With `prefix` (records 0..k-1, with .at/.end, already known consistent) only the
 * records after it are searched, beginning at `from` (default: the end of the prefix); `upTo` bounds where a record may begin.
 */
function findRecordSequences(buf, start, count, { limit = CANDIDATE_LIMIT, prefix = [], from: fromOpt, upTo = Infinity } = {}) {
  const solutions = [];
  const chosen = prefix.map((c) => ({ ...c }));
  const expect = new Map(); // channel offset -> {role, pair} demanded by an earlier record that points forward
  chosen.forEach((c, j) => {
    const had = expect.get(j);
    if (had) expect.delete(j);
    else if (c.role !== 0 && c.pair > j) expect.set(c.pair, { role: c.role === 1 ? 2 : 1, pair: j });
  });
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
    const last = i === 0 ? from : Math.min(buf.length - 4, from + MAX_GAP, upTo);
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
  const k = prefix.length;
  place(k, k ? (fromOpt ?? prefix[k - 1].end) : start);
  return { solutions, exhausted, nodes, truncated: solutions.length >= limit };
}

function sameChannels(a, b) {
  return a.length === b.length && a.every((c, i) => c.name === b[i].name && c.role === b[i].role && c.pair === b[i].pair);
}

/** The structural part of a block before its records: GUID, name, properties, channel count. Returns {ok, ...} or {ok:false, error}. */
function parseHeader(obj, at) {
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
  r.ok = true;
  return r;
}

/** Byte position of the first thing at or after `after` that has the shape of a mode block (header + a valid first record head), or null. */
function nextBlockStart(obj, after) {
  for (let p = after; p + 24 <= obj.length; p++) {
    const h = parseHeader(obj, p);
    if (h.ok && recordHead(obj, h.recordsAt, h.channelCount)) return p;
  }
  return null;
}

const strip = (sol) => sol.map(({ offset, name: n, role, pair }) => ({ offset, name: n, role, pair }));
const distinct = (sols) => {
  const cands = [];
  for (const sol of sols) { const c = strip(sol); if (!cands.some((x) => sameChannels(x, c))) cands.push(c); }
  return cands;
};

/** Try to read a mode block whose GUID starts at `at`. Returns {ok, ...} with `error` when the structure doesn't parse. */
function parseBlockAt(obj, at) {
  const hd = parseHeader(obj, at);
  if (!hd.ok) return hd;
  const r = { ...hd, ok: false, notes: [] };
  const first = findRecordSequences(obj, r.recordsAt, r.channelCount, { limit: 2 });
  r.nodes = first.nodes; r.searchExhausted = first.exhausted;
  if (!first.solutions.length) return { ...r, error: `no consistent sequence of ${r.channelCount} channel records starts at ${r.recordsAt}${first.exhausted ? ' (search budget used up)' : ''}` };
  const G = first.solutions[0];
  let cands = [strip(G)], truncated = false;
  if (first.solutions.length > 1) {
    const S1 = first.solutions[1];
    const d = G.findIndex((c, i) => c.at !== S1[i].at || c.name !== S1[i].name || c.role !== S1[i].role || c.pair !== S1[i].pair);
    if (d < r.channelCount - 1) {
      // alternatives that differ before the final record: enumerate strictly (all of them, or refuse if there are too many)
      const all = findRecordSequences(obj, r.recordsAt, r.channelCount);
      cands = distinct(all.solutions); truncated = all.truncated; r.nodes += all.nodes;
      if (all.exhausted) r.searchExhausted = true;
    } else {
      // alternatives for the FINAL record only: another valid-looking record string in the final record's tail, or the first record
      // of the next mode block. Those inside this block (before the next header) are candidates; the rest are outside it.
      const prefix = G.slice(0, -1);
      const nb = nextBlockStart(obj, G[G.length - 1].end);
      const inside = findRecordSequences(obj, r.recordsAt, r.channelCount, { limit: FINAL_LIMIT, prefix, upTo: nb === null ? Infinity : nb - 1 });
      cands = distinct(inside.solutions); truncated = inside.truncated; r.nodes += inside.nodes;
      if (inside.exhausted) r.searchExhausted = true;
      let outside = 0, capped = false;
      if (nb !== null) {
        const out = findRecordSequences(obj, r.recordsAt, r.channelCount, { limit: OUTSIDE_COUNT_LIMIT, prefix, from: nb });
        outside = out.solutions.length; capped = out.truncated;
      }
      r.finalFamily = { insideCount: cands.length, outsideCount: outside, outsideCapped: capped, nextBlockAt: nb };
      if (outside) r.notes.push(`${outside}${capped ? '+' : ''} other reading(s) of the final channel record lie at or beyond byte ${nb}, where the next mode block starts, i.e. outside this block; ignored`);
      // for information only (does not gate anything): would a strict comparison of EVERY consistent reading of the whole list agree?
      const all = findRecordSequences(obj, r.recordsAt, r.channelCount);
      r.nodes += all.nodes;
      const allC = distinct(all.solutions);
      if (allC.length > 1 || all.truncated) {
        const st = resolveAmbiguity(allC, { truncated: all.truncated, limit: CANDIDATE_LIMIT });
        r.strictCheck = { readings: allC.length, truncated: all.truncated, agree: st.ok };
        r.notes.push(st.ok
          ? `for information: all ${allC.length} consistent readings of the whole list (including those that start in the next block) agree on every driven channel`
          : `WARNING (information, not used to decide): a strict comparison of all ${allC.length}${all.truncated ? '+' : ''} consistent readings of the whole list, including shifted ones, does NOT agree on the driven channels (${st.error.replace(/^the candidate channel lists disagree on a channel that would be driven: /, '')}); the table printed is the first reading in file order, verify it against Capture's patch view`);
      }
      r.notes.push('alternatives were compared for the final channel record only (a record\'s tail is undecoded, so earlier records could in principle also be mis-split); check the printed channel table against the fixture\'s patch view in Capture');
    }
  }
  r.channels = cands[0];
  r.candidates = cands;
  r.candidatesTruncated = truncated;
  r.candidateLimit = r.finalFamily ? FINAL_LIMIT : CANDIDATE_LIMIT;
  r.ambiguous = cands.length > 1 || truncated;
  if (r.ambiguous) r.alternative = cands[1];
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
    if (first.notes?.length) warnings.push(...first.notes);
    if (first.ambiguous) return { ...first, ok: false, encoding, blockAt: first.at, error: `more than one consistent channel-record sequence exists (${first.candidates.length}${first.candidatesTruncated ? '+' : ''} candidates): ${describeDiff(first.candidates)}`, warnings };
    if (first.searchExhausted) warnings.push('search budget used up while checking for alternative parses; the parse found is consistent but uniqueness is not proven');
    return { ok: true, encoding, blockAt: first.at, name: first.name, props: first.props, channelCount: first.channelCount, channels: first.channels, warnings };
  }
  return { ok: false, error: `mode block not found: ${tried.join(' | ')}`, warnings };
}

/** Offsets where the candidate lists are not all identical (name, role or pair differs from the first candidate). */
export function differingOffsets(cands) {
  const n = Math.max(...cands.map((c) => c.length));
  const out = [];
  for (let i = 0; i < n; i++) {
    const f = cands[0][i];
    if (cands.some((c) => !c[i] || !f || c[i].name !== f.name || c[i].role !== f.role || c[i].pair !== f.pair)) out.push(i);
  }
  return out;
}
const describeAt = (cands, i) => `${i}: ${[...new Set(cands.map((c) => (c[i] ? JSON.stringify(c[i].name) : '(none)')))].join(' vs ')}`;
const describeDiff = (cands) => `differ at offsets [${differingOffsets(cands).join(', ')}] (${differingOffsets(cands).slice(0, 6).map((i) => describeAt(cands, i)).join('; ')})`;

// ---------------------------------------------------------------- attribute mapping by name

/** Lower-case word tokens of a channel name; camelCase is split ("PanFine" -> pan fine). */
export function tokens(name) {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
/** Channels that are about a different thing even if the word matches ("Pan/Tilt Speed", "Dimmer Curve", "Shutter Mode"). */
export const NOT_THE_VALUE = new Set(['speed', 'time', 'macro', 'reset', 'mode', 'control', 'ctrl', 'rate', 'curve', 'function', 'func', 'response', 'duration', 'invert', 'reverse', 'inverse']);

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

const ATTRS = ['pan', 'tilt', 'intensity', 'shutter'];
const pick = (c) => (c ? { offset: c.offset, name: c.name, role: c.role, pair: c.pair } : null);
/** What a candidate list means for the channels dmx-proof drives: offset, name, role, pair of each mapped channel and its fine partner. */
function drivenSignature(channels) {
  const { map, missing } = mapAttributes(channels);
  const sig = {};
  for (const a of ATTRS) sig[a] = map[a] ? { coarse: pick(map[a].coarse), fine: pick(map[a].fine) } : null;
  return { sig, missing };
}

/**
 * Several consistent channel lists exist (the final record's tail holds a string that also looks like a record, for example).
 * Compute the attribute mapping for EACH candidate. If every candidate gives the same offsets, names, roles and pairs for every
 * mapped channel (pan, tilt, intensity, shutter and their fine partners), the ambiguity does not touch anything that is driven.
 * Result: {ok, channels (the preferred candidate), differOffsets, drivenOffsets, disagree[]}.
 * The preferred candidate is the first one in FILE ORDER. The end-of-block test ("last record followed by valid data that is not a
 * channel record") is not decidable here, because the rest of a record is undecoded, so its length is unknown. The slots at
 * `differOffsets` are never driven (only mapped channels are), and that is checked here too.
 */
export function resolveAmbiguity(candidates, { truncated = false, limit = CANDIDATE_LIMIT } = {}) {
  const differOffsets = differingOffsets(candidates);
  if (truncated) return { ok: false, differOffsets, disagree: [], error: `more than ${limit} candidate channel lists exist; not all of them were compared` };
  const sigs = candidates.map((c) => drivenSignature(c));
  const disagree = ATTRS.filter((a) => sigs.some((x) => JSON.stringify(x.sig[a]) !== JSON.stringify(sigs[0].sig[a])));
  if (disagree.length) {
    const show = (a) => [...new Set(sigs.map((x) => (x.sig[a] ? `offset ${x.sig[a].coarse.offset} "${x.sig[a].coarse.name}"${x.sig[a].fine ? ` + fine ${x.sig[a].fine.offset} "${x.sig[a].fine.name}"` : ''}` : 'not found')))].join(' vs ');
    return { ok: false, differOffsets, disagree, error: `the candidate channel lists disagree on a channel that would be driven: ${disagree.map((a) => `${a}: ${show(a)}`).join('; ')}` };
  }
  const driven = new Set();
  for (const a of ATTRS) { const e = sigs[0].sig[a]; if (e) { driven.add(e.coarse.offset); if (e.fine) driven.add(e.fine.offset); } }
  const clash = differOffsets.filter((o) => driven.has(o));
  if (clash.length) return { ok: false, differOffsets, disagree: [], error: `internal check failed: driven offset(s) ${clash.join(', ')} differ between candidates` };
  return { ok: true, channels: candidates[0], candidates, differOffsets, drivenOffsets: [...driven].sort((x, y) => x - y), disagree: [] };
}

/** One line for the log: which offsets differ and how. */
export function ambiguityNote(candidates, differOffsets) {
  const shown = differOffsets.slice(0, 6).map((i) => describeAt(candidates, i)).join('; ');
  return `${candidates.length} candidate channel lists differ only at offsets [${differOffsets.join(', ')}] (not used by this test): ${shown}${differOffsets.length > 6 ? '; ...' : ''}`;
}

/**
 * The gate dmx-proof passes before it may send anything: the mode block must parse (uniquely, or with candidates that agree on
 * every driven channel, see resolveAmbiguity) AND the parsed channel count must equal both the count stored in the block and the
 * ChannelCount Capture reported for the fixture (CAEX FixtureList).
 * Result: {ok, channels?, block, ambiguity?, error?}.
 */
export function loadChannels(obj, modeRawGuid, caexChannelCount) {
  const block = parseModeBlock(obj, modeRawGuid);
  let channels = block.channels, ambiguity = null;
  if (!block.ok) {
    if (!block.ambiguous) return { ok: false, block, error: block.error };
    ambiguity = resolveAmbiguity(block.candidates, { truncated: block.candidatesTruncated, limit: block.candidateLimit });
    if (!ambiguity.ok) return { ok: false, block, ambiguity, error: `${block.error}. ${ambiguity.error}` };
    channels = ambiguity.channels;
  }
  const n = channels.length;
  if (n !== block.channelCount) return { ok: false, block, error: `parsed ${n} channel(s) but the mode block says channelCount=${block.channelCount}` };
  if (n !== caexChannelCount) return { ok: false, block, error: `mode block has ${n} channel(s) but Capture's patch says ChannelCount=${caexChannelCount} for this fixture` };
  return { ok: true, block, channels, ambiguity };
}
