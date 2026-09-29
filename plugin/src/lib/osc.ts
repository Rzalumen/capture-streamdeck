/**
 * Minimal OSC 1.0 codec (no dependencies).
 *
 * Capture's OSC interface (manual Appendix §21.4.3, "OSC") speaks OSC 1.0/1.1 over UDP/TCP
 * and does NOT support address patterns or bundles, so only single messages are handled.
 * https://www.capture.se/Manual/en-UK/2026/Appendix.html
 *
 * Supported argument types: i (int32), f (float32), s (string), T, F.
 * Also decoded (never sent): h (int64), d (float64), N, I, b (blob).
 */

export type OscArg =
  | { t: "i"; v: number }
  | { t: "f"; v: number }
  | { t: "s"; v: string }
  | { t: "T" }
  | { t: "F" };

export type OscValue = number | string | boolean | bigint | null | Buffer;

export interface OscMessage {
  address: string;
  /** Type tag string without the leading comma, e.g. "iffffff". */
  types: string;
  args: OscValue[];
}

/** Always-float helper: whole numbers are still sent as `f` (Capture requires float32). */
export const oscF = (v: number): OscArg => ({ t: "f", v });
export const oscI = (v: number): OscArg => ({ t: "i", v: Math.trunc(v) });
export const oscS = (v: string): OscArg => ({ t: "s", v });
export const oscBool = (v: boolean): OscArg => (v ? { t: "T" } : { t: "F" });

const pad4 = (n: number): number => (n + 3) & ~3;

function encodeString(s: string): Buffer {
  const raw = Buffer.from(s, "utf8");
  if (raw.includes(0)) throw new Error("OSC string may not contain NUL");
  const out = Buffer.alloc(pad4(raw.length + 1)); // NUL terminated, padded to 4 bytes
  raw.copy(out);
  return out;
}

export function encodeMessage(address: string, args: OscArg[] = []): Buffer {
  if (!address.startsWith("/")) throw new Error(`OSC address must start with "/": ${address}`);
  const parts: Buffer[] = [encodeString(address), encodeString("," + args.map((a) => a.t).join(""))];
  for (const a of args) {
    switch (a.t) {
      case "i": {
        if (!Number.isInteger(a.v) || a.v < -2147483648 || a.v > 2147483647) {
          throw new Error(`OSC int32 out of range: ${a.v}`);
        }
        const b = Buffer.alloc(4);
        b.writeInt32BE(a.v);
        parts.push(b);
        break;
      }
      case "f": {
        if (!Number.isFinite(a.v)) throw new Error(`OSC float must be finite: ${a.v}`);
        const b = Buffer.alloc(4);
        b.writeFloatBE(a.v);
        parts.push(b);
        break;
      }
      case "s":
        parts.push(encodeString(a.v));
        break;
      case "T":
      case "F":
        break; // no payload
    }
  }
  return Buffer.concat(parts);
}

function readString(buf: Buffer, off: number): [string, number] {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  if (end >= buf.length) throw new Error("OSC: unterminated string");
  const s = buf.toString("utf8", off, end);
  return [s, off + pad4(end - off + 1)];
}

export function decodeMessage(buf: Buffer): OscMessage {
  if (buf.length < 4) throw new Error("OSC: packet too short");
  if (buf[0] === 0x23 /* '#' */) throw new Error("OSC: bundles are not supported");
  let off = 0;
  let address: string;
  [address, off] = readString(buf, off);
  if (!address.startsWith("/")) throw new Error(`OSC: bad address "${address}"`);
  let tags = "";
  if (off < buf.length) {
    [tags, off] = readString(buf, off);
    if (!tags.startsWith(",")) throw new Error(`OSC: bad type tag string "${tags}"`);
  } else {
    tags = ",";
  }
  const types = tags.slice(1);
  const args: OscValue[] = [];
  for (const t of types) {
    switch (t) {
      case "i":
        args.push(buf.readInt32BE(off));
        off += 4;
        break;
      case "f":
        args.push(buf.readFloatBE(off));
        off += 4;
        break;
      case "h":
        args.push(buf.readBigInt64BE(off));
        off += 8;
        break;
      case "d":
        args.push(buf.readDoubleBE(off));
        off += 8;
        break;
      case "s": {
        let s: string;
        [s, off] = readString(buf, off);
        args.push(s);
        break;
      }
      case "b": {
        const len = buf.readInt32BE(off);
        off += 4;
        args.push(buf.subarray(off, off + len));
        off += pad4(len);
        break;
      }
      case "T":
        args.push(true);
        break;
      case "F":
        args.push(false);
        break;
      case "N":
      case "I":
        args.push(null);
        break;
      default:
        throw new Error(`OSC: unsupported type tag "${t}"`);
    }
  }
  return { address, types, args };
}
