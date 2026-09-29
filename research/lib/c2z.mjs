// Read-only reader for Capture's Library.c2z (Capture 2026 format, as verified by hand).
//
// Format facts this builds on:
//  1. File starts with a zlib stream (78 da) holding the "tree" (~9.5 MB), which begins with ASCII "c2z ".
//  2. Data base H = first byte after that zlib stream. Found via the Adler-32 of the inflated tree
//     (4 bytes big-endian, located in the raw file; H = position + 4). Cross-checked against the
//     number of input bytes zlib consumed.
//  3. Tree entry names are UTF-16LE, null-terminated; a file entry name is followed by
//     u32 LE offset (relative to H) and u32 LE uncompressed size. No full tree parser on purpose.
//  4. Each entry at H+offset is its own zlib stream; inflated length must equal size.
//  5. Index.c2t is the catalog; its offset/size come from the tree.
//  6. Index.c2t strings are length-prefixed ASCII: u32 LE length = BYTES + 1, no terminator stored.
//
// Nothing in here writes to disk. The library file is only ever opened read-only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export const DEFAULT_LIB = path.join(
  os.homedir(), 'Library', 'Application Support', 'Capture 2026', 'Library.c2z');

const HEAD_READ = 32 * 1024 * 1024; // "reading the first 32 MB raw is enough"

export function adler32(buf) {
  let a = 1, b = 0;
  const MOD = 65521;
  let i = 0;
  while (i < buf.length) {
    const end = Math.min(i + 5552, buf.length);
    for (; i < end; i++) { a += buf[i]; b += a; }
    a %= MOD; b %= MOD;
  }
  return (((b << 16) | a) >>> 0);
}

export const isPrintable = (c) => c >= 0x20 && c <= 0x7e;

/** Parse "--lib <path>" from argv. */
export function libPathFromArgs(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--lib');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1].replace(/^~(?=$|\/)/, os.homedir()));
  return DEFAULT_LIB;
}

/**
 * Index.c2t string rule (verified on real bytes): the u32 LE length = the string's BYTE length + 1,
 * and NO terminator byte is stored. E.g. 04000000 426172 -> len 4, "Bar" (3 bytes).
 * `lpString` returns {str, end, len} for a printable, non-empty string at `pos` (end = byte after
 * the last string byte), or null. `maxBytes` bounds the string's byte length.
 */
export function lpString(buf, pos, maxBytes = 400) {
  if (pos < 0 || pos + 4 > buf.length) return null;
  const len = buf.readUInt32LE(pos);
  const n = len - 1;
  if (n < 1 || n > maxBytes || pos + 4 + n > buf.length) return null;
  for (let i = 0; i < n; i++) if (!isPrintable(buf[pos + 4 + i])) return null;
  return { str: buf.toString('latin1', pos + 4, pos + 4 + n), end: pos + 4 + n, len };
}

/** Encode a string with the Index.c2t rule (u32 LE bytes+1, then the bytes, no terminator). */
export function lpEncode(str) {
  const b = Buffer.from(str, 'latin1');
  const out = Buffer.alloc(4 + b.length);
  out.writeUInt32LE(b.length + 1, 0);
  b.copy(out, 4);
  return out;
}

/** Length-prefixed strings (Index.c2t rule) whose string bytes END exactly at `end`. Normally one. */
export function lpStringsEndingAt(buf, end, maxBytes = 200) {
  const found = [];
  for (let n = 1; n <= maxBytes; n++) {
    const at = end - n - 4;
    if (at < 0) break;
    if (buf.readUInt32LE(at) !== n + 1) continue;
    let ok = true;
    for (let i = 0; i < n; i++) if (!isPrintable(buf[at + 4 + i])) { ok = false; break; }
    if (ok) found.push({ at, str: buf.toString('latin1', at + 4, end) });
  }
  return found;
}

export function openLibrary(libPath = DEFAULT_LIB) {
  const fd = fs.openSync(libPath, 'r'); // read-only
  const fileSize = fs.fstatSync(fd).size;
  const log = []; // diagnostics surfaced to callers

  const headLen = Math.min(fileSize, HEAD_READ);
  const head = Buffer.alloc(headLen);
  fs.readSync(fd, head, 0, headLen, 0);

  if (!(head[0] === 0x78)) log.push(`WARN: first byte is 0x${head[0].toString(16)}, expected zlib header 0x78`);

  // --- tree: first zlib stream ---
  let tree, consumed = null;
  {
    const r = zlib.inflateSync(head, { info: true });
    tree = r.buffer;
    consumed = r.engine.bytesWritten; // input bytes consumed by zlib
  }
  const magic = tree.subarray(0, 4).toString('latin1');
  if (magic !== 'c2z ') log.push(`WARN: tree magic is ${JSON.stringify(magic)}, expected "c2z "`);

  // --- H via Adler-32 (the verified method) ---
  const adler = adler32(tree);
  const adlerBytes = Buffer.alloc(4); adlerBytes.writeUInt32BE(adler);
  const adlerPos = head.indexOf(adlerBytes);
  if (adlerPos < 0) throw new Error(`Adler-32 ${adlerBytes.toString('hex')} of the tree not found in first ${headLen} bytes`);
  const H = adlerPos + 4;
  log.push(`H = ${H} (Adler-32 of tree = 0x${adler.toString(16).padStart(8, '0')} found at raw offset ${adlerPos})`);
  if (consumed !== null) {
    log.push(consumed === H
      ? `H cross-check: zlib consumed ${consumed} input bytes -> same H`
      : `WARN: zlib consumed ${consumed} input bytes but Adler-32 method gives H=${H}`);
  }

  const entryCache = new Map();

  function utf16z(name) {
    return Buffer.concat([Buffer.from(name, 'utf16le'), Buffer.from([0, 0])]);
  }

  /** All raw matches of "<name>\0" in the tree with the following (offset, size) pair. */
  function findEntryMatches(name) {
    const needle = utf16z(name);
    const out = [];
    let from = 0;
    for (;;) {
      const pos = tree.indexOf(needle, from);
      if (pos < 0) break;
      const p = pos + needle.length;
      if (p + 8 <= tree.length) {
        out.push({ treePos: pos, offset: tree.readUInt32LE(p), size: tree.readUInt32LE(p + 4) });
      }
      from = pos + 1;
    }
    return out;
  }

  function inflateAt(offset, size) {
    const start = H + offset;
    if (start >= fileSize) throw new Error(`entry offset ${offset} -> file position ${start} beyond end of file (${fileSize})`);
    const want = Math.min(fileSize - start, Math.floor(size * 1.1) + 65536);
    const raw = Buffer.alloc(want);
    fs.readSync(fd, raw, 0, want, start);
    return zlib.inflateSync(raw);
  }

  /**
   * Locate + inflate an entry. Returns {name, treePos, offset, size, inflated, sizeOk, matches}.
   * When a name matches more than once in the tree, the first match that inflates is used
   * and the count is reported. Size mismatches are logged (never silently ignored).
   */
  function entryInfo(name) {
    if (entryCache.has(name)) return entryCache.get(name);
    const matches = findEntryMatches(name);
    if (!matches.length) throw new Error(`entry ${JSON.stringify(name)} not found in tree`);
    let lastErr = null, result = null;
    for (const m of matches) {
      try {
        const data = inflateAt(m.offset, m.size);
        const sizeOk = data.length === m.size;
        if (!sizeOk) log.push(`WARN: entry ${name}: inflated length ${data.length} != tree size ${m.size}`);
        result = { name, ...m, inflated: data, inflatedLength: data.length, sizeOk, matchCount: matches.length };
        break;
      } catch (e) { lastErr = e; }
    }
    if (!result) throw new Error(`entry ${JSON.stringify(name)}: ${matches.length} tree match(es), none inflated (${lastErr && lastErr.message})`);
    entryCache.set(name, result);
    return result;
  }

  const readEntry = (name) => entryInfo(name).inflated;

  const PATH_PREFIX = '_LightingFixtures\\';

  let indexBuf = null;
  const getIndex = () => (indexBuf ||= readEntry('Index.c2t'));

  /**
   * Fixture lookup, using the layout verified on a real Capture 2026 library:
   *   [len]"_LightingFixtures\<Manufacturer>\<Category>\<guid>.c2o"  ... ~90-93 bytes binary ...
   *   [len]"<Manufacturer>" [len]"<Model>"  ...PNG...
   * 1. exact match of u32LE(len(model)+1) + model bytes in Index.c2t (exact, not substring);
   * 2. manufacturer = the length-prefixed string immediately before the hit;
   * 3. scan back up to 512 bytes for the nearest length-prefixed string that starts with
   *    "_LightingFixtures\" and ends with ".c2o"; otherwise the hit is rejected as a non-lighting
   *    record (the nearest other "_Xxx\..." path is reported, e.g. _Symbols\).
   * Every hit is returned, accepted or not:
   *   {accepted, indexOffset, modelTextOffset, manufacturer, model, path, guidFile, reason, pathFound}
   * indexOffset = position of the model's LENGTH FIELD; modelTextOffset = indexOffset + 4
   * (the position of the model text itself).
   */
  function findFixtureRecords(model) {
    const idx = getIndex();
    const needle = lpEncode(model); // u32LE(bytes+1) + model bytes
    const hits = [];
    let from = 0;
    for (;;) {
      const at = idx.indexOf(needle, from);
      if (at < 0) break;
      from = at + 1;
      const h = { accepted: false, indexOffset: at, modelTextOffset: at + 4, model,
        manufacturer: '', path: '', guidFile: '', reason: '', pathFound: '' };
      const mfrs = lpStringsEndingAt(idx, at);
      if (mfrs.length) h.manufacturer = mfrs[0].str;
      else h.reason = 'no length-prefixed manufacturer string immediately before model';
      if (mfrs.length > 1) h.reason += ` (${mfrs.length} candidate manufacturer strings; used the shortest)`;
      // nearest length-prefixed path within 512 bytes before the model's length field
      const lo = Math.max(0, at - 512);
      let lighting = null, other = null;
      for (let pos = at - 5; pos >= lo && !lighting; pos--) {
        const s = lpString(idx, pos, 300);
        if (!s || s.end > at) continue;
        if (s.str.startsWith(PATH_PREFIX) && s.str.endsWith('.c2o')) lighting = s.str;
        else if (!other && /^_[A-Za-z]+\\/.test(s.str)) other = s.str;
      }
      if (lighting) {
        h.accepted = true; h.path = lighting; h.guidFile = lighting.slice(lighting.lastIndexOf('\\') + 1);
      } else {
        h.pathFound = other || '(no "_Xxx\\" path found within 512 bytes before the model)';
        h.reason = `non-lighting record: no ${PATH_PREFIX}...c2o within 512 bytes before the model; nearest path: ${h.pathFound}` + (h.reason ? ` [${h.reason}]` : '');
      }
      hits.push(h);
    }
    return hits;
  }

  let indexRecords = null;
  /**
   * All `_LightingFixtures\...c2o` records in Index.c2t, in file order (for listing only; the fixture
   * lookup above does not depend on it). The manufacturer/model strings sit ~90-93 bytes AFTER the
   * path, not directly behind it; they're found by looking for the manufacturer name from the path
   * followed by another length-prefixed string. Model parsing here is best-effort (unverified).
   */
  function allIndexRecords() {
    if (indexRecords) return indexRecords;
    const idx = getIndex();
    const marker = Buffer.from(PATH_PREFIX, 'latin1');
    const recs = [];
    let from = 0;
    for (;;) {
      const at = idx.indexOf(marker, from);
      if (at < 0) break;
      from = at + 1;
      const s = lpString(idx, at - 4, 300);
      if (!s || !s.str.startsWith(PATH_PREFIX) || !s.str.endsWith('.c2o')) continue;
      const segs = s.str.split('\\');
      const mfrPath = segs[1] || '';
      let manufacturer = '', model = '';
      if (mfrPath) {
        const mNeedle = lpEncode(mfrPath);
        const w = idx.subarray(s.end, Math.min(idx.length, s.end + 300));
        const k = w.indexOf(mNeedle);
        if (k >= 0) {
          const r = lpString(idx, s.end + k + mNeedle.length, 200);
          manufacturer = mfrPath;
          if (r) model = r.str;
        }
      }
      recs.push({ path: s.str, manufacturer, model, guidFile: segs[segs.length - 1], indexOffset: at - 4 });
    }
    return (indexRecords = recs);
  }

  /** Records under _LightingFixtures\ whose path/manufacturer/model contains `substring` (case-insensitive). */
  function findIndexRecords(substring = '') {
    const q = substring.toLowerCase();
    return allIndexRecords().filter((r) =>
      !q || r.path.toLowerCase().includes(q) ||
      r.model.toLowerCase().includes(q) ||
      r.manufacturer.toLowerCase().includes(q) ||
      `${r.manufacturer} ${r.model}`.toLowerCase().includes(q));
  }

  return {
    libPath, fileSize, H, tree, treeSize: tree.length, log,
    entryInfo, readEntry, findEntryMatches, findFixtureRecords, findIndexRecords, allIndexRecords,
    close: () => fs.closeSync(fd),
  };
}
