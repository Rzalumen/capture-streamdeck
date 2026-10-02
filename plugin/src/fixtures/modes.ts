/**
 * DMX-mode block parser for Capture library objects (.c2o). Ported from research/lib/modes.mjs (the research copy is unchanged).
 * NOTHING here knows any fixture type: it works from the bytes of the object and the channel names it finds.
 *
 * VERIFIED FACTS this builds on (from mode-probe on real objects; matched Capture's patch view on a 56-channel Rogue R2X Wash):
 *  * The AtlaBaseModeId's raw-order GUID string appears in the object in COM mixed-endian byte encoding.
 *  * The block starts at that GUID:
 *      [16-byte GUID][u32 len+1, name][u32 propCount]{u32 len+1 key, u32 type, u32 len+1 value}*propCount
 *      [u32 channelCount]{channel record}*channelCount
 *    (string = u32 length that is BYTES + 1, no terminator.)
 *  * A channel record starts with its name followed by u8 role and u16 pair (little endian):
 *      role 0 = 8-bit (pair 0xFFFF); role 1 = coarse (pair = 0-based offset of its fine channel);
 *      role 2 = fine (pair = offset of its coarse channel).
 *    The rest of a record is NOT decoded, so its length is unknown and it can hold other strings (wheel slot names ...). The sequence
 *    of records is chosen so that (a) record 0 begins right after channelCount, (b) records do not overlap and keep file order,
 *    (c) pair pointers are mutually consistent by channel offset (the k-th record IS channel offset k), (d) exactly channelCount records.
 *  If more than one such sequence exists the parse is reported ambiguous (ok:false, `candidates`) and callers must not send DMX
 *  unless resolveAmbiguity() shows the candidates agree on every channel they intend to drive. Which alternatives are compared: when
 *  the first sequence has alternatives for the FINAL record only, every reading of that record before the next mode-block header is a
 *  candidate (those at or beyond the header are outside the block and ignored); alternatives that differ earlier are enumerated
 *  strictly (up to CANDIDATE_LIMIT) when no final-record alternative exists.
 */

export const ROLE_NAMES = ["8-bit", "coarse", "fine"] as const;
const MAX_NAME = 64;
const MAX_PROPS = 512;
const MAX_CHANNELS = 512;
const MAX_GAP = 16384; // bytes searched for the next record after the previous record's role/pair
const NODE_BUDGET = 300000;
const CANDIDATE_LIMIT = 32;
const FINAL_LIMIT = 500;
const OUTSIDE_COUNT_LIMIT = 50;

export interface Channel {
  offset: number;
  name: string;
  role: number;
  pair: number;
}
interface Rec extends Channel {
  at: number;
  end: number;
}
interface Head {
  name: string;
  role: number;
  pair: number;
  start: number;
  end: number;
}

const isAscii = (c: number): boolean => c >= 0x20 && c <= 0x7e;

/** Raw-order GUID string -> its 16 bytes in raw order. */
export const rawGuidBytes = (g: string): Buffer => Buffer.from(g.replace(/-/g, ""), "hex");
/** Raw-order GUID string -> its 16 bytes in COM mixed-endian encoding (first three groups byte-swapped). */
export function comGuidBytes(g: string): Buffer {
  const b = rawGuidBytes(g);
  b.subarray(0, 4).reverse();
  b.subarray(4, 6).reverse();
  b.subarray(6, 8).reverse();
  return b;
}

/** u32 len = bytes + 1, then the bytes. `allowEmpty` accepts len 1 (empty string). */
function lp(buf: Buffer, pos: number, { max = 200, allowEmpty = false, ascii = true } = {}): { s: string; end: number } | null {
  if (pos < 0 || pos + 4 > buf.length) return null;
  const len = buf.readUInt32LE(pos);
  const n = len - 1;
  if (len < 1 || n > max || (n === 0 && !allowEmpty) || pos + 4 + n > buf.length) return null;
  for (let i = 0; i < n; i++) if (ascii && !isAscii(buf[pos + 4 + i])) return null;
  return { s: buf.toString("latin1", pos + 4, pos + 4 + n), end: pos + 4 + n };
}

/** A channel-record head at `pos`: name string then u8 role, u16 pair; null unless role/pair are structurally valid. */
function recordHead(buf: Buffer, pos: number, count: number): Head | null {
  const nm = lp(buf, pos, { max: MAX_NAME });
  if (!nm || nm.end + 3 > buf.length) return null;
  const role = buf[nm.end];
  const pair = buf.readUInt16LE(nm.end + 1);
  if (role > 2) return null;
  if (role === 0 ? pair !== 0xffff : pair >= count) return null;
  return { name: nm.s, role, pair, start: pos, end: nm.end + 3 };
}

interface SeqOptions {
  limit?: number;
  prefix?: Rec[];
  from?: number;
  upTo?: number;
}
interface SeqResult {
  solutions: Rec[][];
  exhausted: boolean;
  nodes: number;
  truncated: boolean;
}

/**
 * Enumerate consistent sequences of `count` records (at most `limit`), depth-first, deepest variations first.
 * Default: record 0 begins exactly at `start`. With `prefix` (records 0..k-1, already known consistent) only the records after it are
 * searched, beginning at `from` (default: the end of the prefix); `upTo` bounds where a record may begin.
 */
function findRecordSequences(buf: Buffer, start: number, count: number, { limit = CANDIDATE_LIMIT, prefix = [], from: fromOpt, upTo = Infinity }: SeqOptions = {}): SeqResult {
  const solutions: Rec[][] = [];
  const chosen: Rec[] = prefix.map((c) => ({ ...c }));
  const expect = new Map<number, { role: number; pair: number }>(); // channel offset -> {role, pair} demanded by an earlier record that points forward
  chosen.forEach((c, j) => {
    const had = expect.get(j);
    if (had) expect.delete(j);
    else if (c.role !== 0 && c.pair > j) expect.set(c.pair, { role: c.role === 1 ? 2 : 1, pair: j });
  });
  let nodes = 0;
  let exhausted = false;

  function accept(i: number, h: Head): boolean {
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

  function place(i: number, from: number): void {
    if (solutions.length >= limit || exhausted) return;
    if (i === count) {
      solutions.push(chosen.map((c) => ({ ...c })));
      return;
    }
    const last = i === 0 ? from : Math.min(buf.length - 4, from + MAX_GAP, upTo);
    for (let q = from; q <= last; q++) {
      if (++nodes > NODE_BUDGET) {
        exhausted = true;
        return;
      }
      const h = recordHead(buf, q, count);
      if (!h || !accept(i, h)) {
        if (i === 0) return;
        continue;
      }
      const had = expect.get(i);
      if (had) expect.delete(i);
      let set = false;
      if (!had && h.role !== 0 && h.pair > i) {
        expect.set(h.pair, { role: h.role === 1 ? 2 : 1, pair: i });
        set = true;
      }
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

const sameChannels = (a: Channel[], b: Channel[]): boolean => a.length === b.length && a.every((c, i) => c.name === b[i].name && c.role === b[i].role && c.pair === b[i].pair);

interface Header {
  ok: true;
  at: number;
  name: string;
  props: { key: string; type: number; value: string }[];
  channelCount: number;
  recordsAt: number;
}
type HeaderResult = Header | { ok: false; at: number; error: string };

/** The structural part of a block before its records: GUID, name, properties, channel count. */
function parseHeader(obj: Buffer, at: number): HeaderResult {
  let p = at + 16;
  const name = lp(obj, p, { max: 200, allowEmpty: true });
  if (!name) return { ok: false, at, error: "no valid mode name after the GUID" };
  p = name.end;
  if (p + 4 > obj.length) return { ok: false, at, error: "object ends before the property count" };
  const propCount = obj.readUInt32LE(p);
  p += 4;
  if (propCount > MAX_PROPS) return { ok: false, at, error: `implausible property count ${propCount}` };
  const props: Header["props"] = [];
  for (let i = 0; i < propCount; i++) {
    const k = lp(obj, p, { max: 200, allowEmpty: true, ascii: false });
    if (!k || k.end + 4 > obj.length) return { ok: false, at, error: `property ${i}: bad key` };
    const type = obj.readUInt32LE(k.end);
    const v = lp(obj, k.end + 4, { max: 4000, allowEmpty: true, ascii: false });
    if (!v) return { ok: false, at, error: `property ${i} (${JSON.stringify(k.s)}): bad value` };
    props.push({ key: k.s, type, value: v.s });
    p = v.end;
  }
  if (p + 4 > obj.length) return { ok: false, at, error: "object ends before the channel count" };
  const channelCount = obj.readUInt32LE(p);
  p += 4;
  if (channelCount < 1 || channelCount > MAX_CHANNELS) return { ok: false, at, error: `implausible channel count ${channelCount}` };
  return { ok: true, at, name: name.s, props, channelCount, recordsAt: p };
}

/** Byte position of the first thing at or after `after` that has the shape of a mode block (header + a valid first record head), or null. */
function nextBlockStart(obj: Buffer, after: number): number | null {
  for (let p = after; p + 24 <= obj.length; p++) {
    const h = parseHeader(obj, p);
    if (h.ok && recordHead(obj, h.recordsAt, h.channelCount)) return p;
  }
  return null;
}

const strip = (sol: Rec[]): Channel[] => sol.map(({ offset, name: n, role, pair }) => ({ offset, name: n, role, pair }));
const distinct = (sols: Rec[][]): Channel[][] => {
  const cands: Channel[][] = [];
  for (const sol of sols) {
    const c = strip(sol);
    if (!cands.some((x) => sameChannels(x, c))) cands.push(c);
  }
  return cands;
};

interface BlockParse {
  ok: boolean;
  at: number;
  error?: string;
  name?: string;
  props?: Header["props"];
  channelCount?: number;
  recordsAt?: number;
  notes: string[];
  nodes: number;
  searchExhausted: boolean;
  channels: Channel[];
  candidates: Channel[][];
  candidatesTruncated: boolean;
  candidateLimit: number;
  ambiguous: boolean;
}

/** Try to read a mode block whose GUID starts at `at`. */
function parseBlockAt(obj: Buffer, at: number): BlockParse {
  const empty = { notes: [] as string[], nodes: 0, searchExhausted: false, channels: [] as Channel[], candidates: [] as Channel[][], candidatesTruncated: false, candidateLimit: CANDIDATE_LIMIT, ambiguous: false };
  const hd = parseHeader(obj, at);
  if (!hd.ok) return { ...empty, ok: false, at, error: hd.error };
  const r: BlockParse = { ...empty, ok: false, at, name: hd.name, props: hd.props, channelCount: hd.channelCount, recordsAt: hd.recordsAt };
  const first = findRecordSequences(obj, hd.recordsAt, hd.channelCount, { limit: 2 });
  r.nodes = first.nodes;
  r.searchExhausted = first.exhausted;
  if (!first.solutions.length) return { ...r, error: `no consistent sequence of ${hd.channelCount} channel records starts at ${hd.recordsAt}${first.exhausted ? " (search budget used up)" : ""}` };
  const G = first.solutions[0];
  let cands: Channel[][] = [strip(G)];
  let truncated = false;
  let finalFamily = false;
  if (first.solutions.length > 1) {
    const S1 = first.solutions[1];
    const d = G.findIndex((c, i) => c.at !== S1[i].at || c.name !== S1[i].name || c.role !== S1[i].role || c.pair !== S1[i].pair);
    if (d < hd.channelCount - 1) {
      // alternatives that differ before the final record: enumerate strictly (all of them, or refuse if there are too many)
      const all = findRecordSequences(obj, hd.recordsAt, hd.channelCount);
      cands = distinct(all.solutions);
      truncated = all.truncated;
      r.nodes += all.nodes;
      if (all.exhausted) r.searchExhausted = true;
    } else {
      // alternatives for the FINAL record only: another valid-looking record string in the final record's tail, or the first record
      // of the next mode block. Those inside this block (before the next header) are candidates; the rest are outside it.
      finalFamily = true;
      const prefix = G.slice(0, -1);
      const nb = nextBlockStart(obj, G[G.length - 1].end);
      const inside = findRecordSequences(obj, hd.recordsAt, hd.channelCount, { limit: FINAL_LIMIT, prefix, upTo: nb === null ? Infinity : nb - 1 });
      cands = distinct(inside.solutions);
      truncated = inside.truncated;
      r.nodes += inside.nodes;
      if (inside.exhausted) r.searchExhausted = true;
      let outside = 0;
      let capped = false;
      if (nb !== null) {
        const out = findRecordSequences(obj, hd.recordsAt, hd.channelCount, { limit: OUTSIDE_COUNT_LIMIT, prefix, from: nb });
        outside = out.solutions.length;
        capped = out.truncated;
      }
      if (outside) r.notes.push(`${outside}${capped ? "+" : ""} other reading(s) of the final channel record lie at or beyond byte ${nb}, where the next mode block starts, i.e. outside this block; ignored`);
      r.notes.push("alternatives were compared for the final channel record only (a record's tail is undecoded, so earlier records could in principle also be mis-split); check the channel list against the fixture's patch view in Capture");
    }
  }
  r.channels = cands[0];
  r.candidates = cands;
  r.candidatesTruncated = truncated;
  r.candidateLimit = finalFamily ? FINAL_LIMIT : CANDIDATE_LIMIT;
  r.ambiguous = cands.length > 1 || truncated;
  r.ok = true;
  return r;
}

export interface ModeBlock {
  ok: boolean;
  error?: string;
  encoding?: string;
  blockAt?: number;
  name?: string;
  channelCount?: number;
  channels: Channel[];
  /** Only when ok is false because of an ambiguity. */
  ambiguous?: boolean;
  candidates?: Channel[][];
  candidatesTruncated?: boolean;
  candidateLimit?: number;
  warnings: string[];
}

/**
 * Find and parse the DMX-mode block of `modeRawGuid` (raw-order string) in a library object.
 * ok is false when the GUID is absent, no hit parses, or the parse is ambiguous (see `error`).
 */
export function parseModeBlock(obj: Buffer, modeRawGuid: string): ModeBlock {
  const warnings: string[] = [];
  const tried: string[] = [];
  const encodings: [string, Buffer][] = [
    ["COM mixed-endian", comGuidBytes(modeRawGuid)],
    ["raw order", rawGuidBytes(modeRawGuid)],
  ];
  for (const [encoding, pat] of encodings) {
    const hits: number[] = [];
    for (let from = 0; ; ) {
      const at = obj.indexOf(pat, from);
      if (at < 0) break;
      hits.push(at);
      from = at + 1;
    }
    if (!hits.length) {
      tried.push(`${encoding}: no occurrence`);
      continue;
    }
    const parsed = hits.map((at) => parseBlockAt(obj, at));
    const good = parsed.filter((x) => x.ok);
    if (!good.length) {
      tried.push(`${encoding}: ${hits.length} occurrence(s), none parse as a block (${parsed.map((x) => `@${x.at}: ${x.error}`).join("; ")})`);
      continue;
    }
    const first = good[0];
    if (good.length > 1 && !good.every((g) => sameChannels(g.channels, first.channels))) {
      return { ok: false, error: `the mode GUID parses as a block at ${good.length} places with different channel lists (${good.map((g) => "@" + g.at).join(", ")})`, channels: [], warnings };
    }
    if (good.length > 1) warnings.push(`mode GUID occurs ${good.length} times with identical channel lists (${good.map((g) => "@" + g.at).join(", ")})`);
    if (encoding !== "COM mixed-endian") warnings.push("the block was found by the RAW-order GUID, not the verified mixed-endian one");
    if (first.notes.length) warnings.push(...first.notes);
    if (first.ambiguous) {
      return {
        ok: false,
        encoding,
        blockAt: first.at,
        name: first.name,
        channelCount: first.channelCount,
        channels: first.channels,
        ambiguous: true,
        candidates: first.candidates,
        candidatesTruncated: first.candidatesTruncated,
        candidateLimit: first.candidateLimit,
        error: `more than one consistent channel-record sequence exists (${first.candidates.length}${first.candidatesTruncated ? "+" : ""} candidates): ${describeDiff(first.candidates)}`,
        warnings,
      };
    }
    if (first.searchExhausted) warnings.push("search budget used up while checking for alternative parses; the parse found is consistent but uniqueness is not proven");
    return { ok: true, encoding, blockAt: first.at, name: first.name, channelCount: first.channelCount, channels: first.channels, warnings };
  }
  return { ok: false, error: `mode block not found: ${tried.join(" | ")}`, channels: [], warnings };
}

/** Offsets where the candidate lists are not all identical (name, role or pair differs from the first candidate). */
export function differingOffsets(cands: Channel[][]): number[] {
  const n = Math.max(...cands.map((c) => c.length));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = cands[0][i];
    if (cands.some((c) => !c[i] || !f || c[i].name !== f.name || c[i].role !== f.role || c[i].pair !== f.pair)) out.push(i);
  }
  return out;
}
const describeAt = (cands: Channel[][], i: number): string => `${i}: ${[...new Set(cands.map((c) => (c[i] ? JSON.stringify(c[i].name) : "(none)")))].join(" vs ")}`;
const describeDiff = (cands: Channel[][]): string => `differ at offsets [${differingOffsets(cands).join(", ")}] (${differingOffsets(cands).slice(0, 6).map((i) => describeAt(cands, i)).join("; ")})`;

/**
 * What a channel list means for the channels that get DRIVEN: attribute name -> the channels (coarse, fine partners, every colour
 * channel ...) it would write. Two candidate lists agree when every attribute gives identical offsets, names, roles and pairs.
 */
export type DrivenSignature = (channels: Channel[]) => Record<string, Channel[]>;

export interface Ambiguity {
  ok: boolean;
  error?: string;
  channels?: Channel[];
  candidates?: Channel[][];
  differOffsets: number[];
  drivenOffsets?: number[];
  disagree: string[];
}

/**
 * Several consistent channel lists exist. Compute the driven attribute channels for EACH candidate; if every candidate gives the same
 * offsets, names, roles and pairs for every attribute, the ambiguity does not touch anything that is driven and the first candidate
 * (file order) is used. Offsets that differ between candidates are never driven (checked here too).
 */
export function resolveAmbiguity(candidates: Channel[][], signature: DrivenSignature, { truncated = false, limit = CANDIDATE_LIMIT } = {}): Ambiguity {
  const differOffsets = differingOffsets(candidates);
  if (truncated) return { ok: false, differOffsets, disagree: [], error: `more than ${limit} candidate channel lists exist; not all of them were compared` };
  const sigs = candidates.map((c) => signature(c));
  const attrs = [...new Set(sigs.flatMap((s) => Object.keys(s)))];
  const key = (s: Record<string, Channel[]>, a: string): string => JSON.stringify((s[a] ?? []).map((c) => [c.offset, c.name, c.role, c.pair]));
  const disagree = attrs.filter((a) => sigs.some((s) => key(s, a) !== key(sigs[0], a)));
  if (disagree.length) {
    const show = (a: string): string => [...new Set(sigs.map((s) => ((s[a] ?? []).length ? (s[a] ?? []).map((c) => `offset ${c.offset} "${c.name}"`).join(" + ") : "not found")))].join(" vs ");
    return { ok: false, differOffsets, disagree, error: `the candidate channel lists disagree on a channel that would be driven: ${disagree.map((a) => `${a}: ${show(a)}`).join("; ")}` };
  }
  const driven = new Set<number>();
  for (const a of attrs) for (const c of sigs[0][a] ?? []) driven.add(c.offset);
  const clash = differOffsets.filter((o) => driven.has(o));
  if (clash.length) return { ok: false, differOffsets, disagree: [], error: `internal check failed: driven offset(s) ${clash.join(", ")} differ between candidates` };
  return { ok: true, channels: candidates[0], candidates, differOffsets, drivenOffsets: [...driven].sort((x, y) => x - y), disagree: [] };
}

/** One line for the log: which offsets differ and how. */
export function ambiguityNote(candidates: Channel[][], differOffsets: number[]): string {
  const shown = differOffsets.slice(0, 6).map((i) => describeAt(candidates, i)).join("; ");
  return `${candidates.length} candidate channel lists differ only at offsets [${differOffsets.join(", ")}] (not used by this test): ${shown}${differOffsets.length > 6 ? "; ..." : ""}`;
}

export interface LoadedChannels {
  ok: boolean;
  error?: string;
  channels: Channel[];
  /** Offsets that differ between candidate lists (never driven); empty when the parse was unique. */
  differOffsets: number[];
  warnings: string[];
  note?: string;
}

/**
 * The gate before a fixture type may be controlled: the mode block must parse (uniquely, or with candidates that agree on every driven
 * channel) AND the parsed channel count must equal both the count stored in the block and the ChannelCount Capture reported for the
 * fixture (CAEX FixtureList).
 */
export function loadChannels(obj: Buffer, modeRawGuid: string, caexChannelCount: number, signature: DrivenSignature): LoadedChannels {
  const block = parseModeBlock(obj, modeRawGuid);
  const fail = (error: string): LoadedChannels => ({ ok: false, error, channels: [], differOffsets: [], warnings: block.warnings });
  let channels = block.channels;
  let differOffsets: number[] = [];
  let note: string | undefined;
  if (!block.ok) {
    if (!block.ambiguous || !block.candidates) return fail(block.error ?? "mode block did not parse");
    const amb = resolveAmbiguity(block.candidates, signature, { truncated: block.candidatesTruncated, limit: block.candidateLimit });
    if (!amb.ok || !amb.channels) return fail(`${block.error}. ${amb.error}`);
    channels = amb.channels;
    differOffsets = amb.differOffsets;
    note = ambiguityNote(block.candidates, amb.differOffsets);
  }
  const n = channels.length;
  if (n !== block.channelCount) return fail(`parsed ${n} channel(s) but the mode block says channelCount=${block.channelCount}`);
  if (n !== caexChannelCount) return fail(`mode block has ${n} channel(s) but Capture's fixture list says ChannelCount=${caexChannelCount} for this fixture`);
  return { ok: true, channels, differOffsets, warnings: block.warnings, note };
}

// ---------------------------------------------------------------- names

/** Lower-case word tokens of a channel name; camelCase is split ("PanFine" -> pan fine). */
export function tokens(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}
/** Channels that are about a different thing even if the word matches ("Pan/Tilt Speed", "Dimmer Curve", "Shutter Mode"). */
export const NOT_THE_VALUE: ReadonlySet<string> = new Set(["speed", "time", "macro", "reset", "mode", "control", "ctrl", "rate", "curve", "function", "func", "response", "duration", "invert", "reverse", "inverse"]);
