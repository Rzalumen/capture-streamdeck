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
//  6. Index.c2t strings are length-prefixed ASCII (u32 LE length + bytes).
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

  /** Length-prefixed ASCII string at pos, or null. */
  function lpString(buf, pos, maxLen = 400) {
    if (pos < 0 || pos + 4 > buf.length) return null;
    const len = buf.readUInt32LE(pos);
    if (len < 1 || len > maxLen || pos + 4 + len > buf.length) return null;
    for (let i = 0; i < len; i++) if (!isPrintable(buf[pos + 4 + i])) return null;
    return { str: buf.toString('latin1', pos + 4, pos + 4 + len), end: pos + 4 + len };
  }

  let indexRecords = null;
  /** All `_LightingFixtures\...` records in Index.c2t, in file order. */
  function allIndexRecords() {
    if (indexRecords) return indexRecords;
    const idx = readEntry('Index.c2t');
    const marker = Buffer.from('_LightingFixtures\\', 'latin1');
    const recs = [];
    let from = 0;
    for (;;) {
      const at = idx.indexOf(marker, from);
      if (at < 0) break;
      from = at + 1;
      const s = lpString(idx, at - 4);
      if (!s || !s.str.startsWith('_LightingFixtures\\')) continue; // marker inside something else
      const p = s.str;
      // manufacturer + model: the next two length-prefixed strings (tolerate a few filler bytes)
      let pos = s.end;
      const next = () => {
        for (let skip = 0; skip <= 32; skip++) {
          const r = lpString(idx, pos + skip, 200);
          if (r) { pos = r.end; return r.str; }
        }
        return '';
      };
      const manufacturer = next();
      const model = next();
      recs.push({
        path: p, manufacturer, model,
        guidFile: p.slice(p.lastIndexOf('\\') + 1),
        indexOffset: at - 4,
      });
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
    entryInfo, readEntry, findEntryMatches, findIndexRecords, allIndexRecords,
    close: () => fs.closeSync(fd),
  };
}
