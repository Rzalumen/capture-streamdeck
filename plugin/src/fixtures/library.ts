/**
 * Read-only reader for Capture's Library.c2z (Capture 2026 format), ported from research/lib/c2z.mjs. Only what the plugin needs:
 * open the file read-only and inflate a fixture object (`<AtlaBaseFixtureId>.c2o`) by its raw-order GUID.
 *
 * Format (verified by hand on a real library): the file starts with a zlib stream holding the "tree" (begins with ASCII "c2z ");
 * the data base H is the first byte after it (found via the Adler-32 of the inflated tree); tree entry names are UTF-16LE,
 * null-terminated, followed by u32 offset (relative to H) and u32 uncompressed size; each entry at H+offset is its own zlib stream.
 * Nothing here writes to disk.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const HEAD_READ = 32 * 1024 * 1024;

/** The Capture 2026 library; falls back to the newest "Capture 20NN" folder that has one. */
export function defaultLibraryPath(home = os.homedir()): string {
  const base = path.join(home, "Library", "Application Support");
  const preferred = path.join(base, "Capture 2026", "Library.c2z");
  if (fs.existsSync(preferred)) return preferred;
  try {
    const dirs = fs
      .readdirSync(base)
      .filter((d) => /^Capture 20\d\d$/.test(d))
      .sort()
      .reverse();
    for (const d of dirs) {
      const p = path.join(base, d, "Library.c2z");
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* no Application Support folder */
  }
  return preferred;
}

export function adler32(buf: Buffer): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  let i = 0;
  while (i < buf.length) {
    const end = Math.min(i + 5552, buf.length);
    for (; i < end; i++) {
      a += buf[i];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

export interface Library {
  libPath: string;
  /** Inflated fixture object for a raw-order GUID (8-4-4-4-12). Throws when absent. */
  readObjectByGuid(rawGuid: string): Buffer;
  close(): void;
}

export function openLibrary(libPath: string = defaultLibraryPath()): Library {
  const fd = fs.openSync(libPath, "r"); // read-only
  try {
    const fileSize = fs.fstatSync(fd).size;
    const headLen = Math.min(fileSize, HEAD_READ);
    const head = Buffer.alloc(headLen);
    fs.readSync(fd, head, 0, headLen, 0);
    const tree = zlib.inflateSync(head);
    if (tree.subarray(0, 4).toString("latin1") !== "c2z ") throw new Error(`not a Capture library: tree magic is ${JSON.stringify(tree.subarray(0, 4).toString("latin1"))}`);
    const adlerBytes = Buffer.alloc(4);
    adlerBytes.writeUInt32BE(adler32(tree));
    const adlerPos = head.indexOf(adlerBytes);
    if (adlerPos < 0) throw new Error(`Adler-32 of the tree not found in the first ${headLen} bytes`);
    const H = adlerPos + 4;

    const utf16z = (name: string): Buffer => Buffer.concat([Buffer.from(name, "utf16le"), Buffer.from([0, 0])]);
    const inflateAt = (offset: number, size: number): Buffer => {
      const start = H + offset;
      if (start >= fileSize) throw new Error(`entry offset ${offset} -> file position ${start} beyond end of file (${fileSize})`);
      const want = Math.min(fileSize - start, Math.floor(size * 1.1) + 65536);
      const raw = Buffer.alloc(want);
      fs.readSync(fd, raw, 0, want, start);
      return zlib.inflateSync(raw);
    };
    const readEntry = (name: string): Buffer => {
      const needle = utf16z(name);
      let lastErr: unknown = null;
      let matches = 0;
      for (let from = 0; ; ) {
        const pos = tree.indexOf(needle, from);
        if (pos < 0) break;
        from = pos + 1;
        const p = pos + needle.length;
        if (p + 8 > tree.length) continue;
        matches++;
        try {
          return inflateAt(tree.readUInt32LE(p), tree.readUInt32LE(p + 4));
        } catch (e) {
          lastErr = e;
        }
      }
      if (!matches) throw new Error(`entry ${JSON.stringify(name)} not found in the library`);
      throw new Error(`entry ${JSON.stringify(name)}: ${matches} tree match(es), none inflated (${(lastErr as Error)?.message})`);
    };
    return {
      libPath,
      readObjectByGuid(rawGuid: string): Buffer {
        const g = String(rawGuid).trim().replace(/^\{|\}$/g, "").toLowerCase();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(g)) throw new Error(`not a GUID (8-4-4-4-12 hex): ${JSON.stringify(rawGuid)}`);
        return readEntry(`${g}.c2o`);
      },
      close: () => fs.closeSync(fd),
    };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}
