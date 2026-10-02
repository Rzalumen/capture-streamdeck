/**
 * CITP / CAEX wire helpers for the READ-ONLY show sync (ported from research/lib/citp.mjs; the research copy is unchanged).
 *
 * The ONLY messages this plugin may ever put on the TCP connection are PINF/PNam and the CAEX codes in ALLOWED_OUTGOING_CAEX
 * (LaserFeedList, EnterShow, LeaveShow, FixtureListRequest, NACK). `isAllowedOutgoing` is checked on every send; anything
 * else (FixtureModify, FixtureRemove, FixtureIdentify, FixtureSelection, ...) is refused. All integers little-endian.
 *
 * Sources: CITP 1.0 base header and PINF layers (jwarwick/citp-lib, puremediaserver CITPDefines.h; PLoc confirmed against real
 * Capture 2026 packets); CAEX layer from "CITP CAEX Specification F" (Capture, 2020-07-03).
 */

export const HEADER_SIZE = 20;

export const hexOf = (buf: Buffer, n = buf.length): string => [...buf.subarray(0, n)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
const fourcc = (b: Buffer, o: number): string | null => (b.length >= o + 4 ? b.toString("latin1", o, o + 4).replace(/[^\x20-\x7e]/g, ".") : null);

function ucs1z(buf: Buffer, pos: number): { s: string; next: number } | null {
  let e = pos;
  while (e < buf.length && buf[e] !== 0) e++;
  if (e >= buf.length) return null;
  return { s: buf.toString("latin1", pos, e), next: e + 1 };
}
function ucs2z(buf: Buffer, pos: number): { s: string; next: number } | null {
  let e = pos;
  while (e + 1 < buf.length && !(buf[e] === 0 && buf[e + 1] === 0)) e += 2;
  if (e + 1 >= buf.length) return null;
  return { s: buf.toString("utf16le", pos, e), next: e + 2 };
}

/** The 16 bytes as plain hex groups in the ORDER RECEIVED (8-4-4-4-12). Library .c2o filenames use this order. */
export function guidRawStr(b: Buffer): string | null {
  if (b.length !== 16) return null;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Mixed-endian (COM) GUID string as in CAEX spec F. */
function guidStr(b: Buffer): string | null {
  if (b.length !== 16) return null;
  const h = (i: number, n: number): string => [...b.subarray(i, i + n)].map((x) => x.toString(16).padStart(2, "0")).join("");
  const r = (i: number, n: number): string => [...b.subarray(i, i + n)].reverse().map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${r(0, 4)}-${r(4, 2)}-${r(6, 2)}-${h(8, 2)}-${h(10, 6)}`;
}

/** 20-byte CITP header (MessagePartCount 1, MessagePart 0). */
export function buildHeader(total: number, contentType: string): Buffer {
  const b = Buffer.alloc(HEADER_SIZE);
  b.write("CITP", 0, "latin1");
  b[4] = 1;
  b[5] = 0;
  b.writeUInt32LE(total, 8);
  b.writeUInt16LE(1, 12);
  b.writeUInt16LE(0, 14);
  b.write(contentType, 16, "latin1");
  return b;
}

/** PINF/PNam: header + 'PNam' + ucs1 Name. */
export function buildPNam(name: string): Buffer {
  const nm = Buffer.concat([Buffer.from(name, "latin1"), Buffer.from([0])]);
  return Buffer.concat([buildHeader(HEADER_SIZE + 4 + nm.length, "PINF"), Buffer.from("PNam", "latin1"), nm]);
}

export const CAEX = {
  NACK: 0xffffffff,
  GetLiveViewStatus: 0x00000100,
  GetLiveViewImage: 0x00000200,
  EnterShow: 0x00020100,
  LeaveShow: 0x00020101,
  FixtureListRequest: 0x00020200,
  FixtureList: 0x00020201,
  FixtureIdentify: 0x00020204,
  GetLaserFeedList: 0x00030100,
  LaserFeedList: 0x00030101,
} as const;

function buildCaexEmpty(code: number): Buffer {
  const b = Buffer.alloc(HEADER_SIZE + 4);
  buildHeader(b.length, "CAEX").copy(b, 0);
  b.writeUInt32LE(code, HEADER_SIZE);
  return b;
}
export const buildFixtureListRequest = (): Buffer => buildCaexEmpty(CAEX.FixtureListRequest);
export const buildLeaveShow = (): Buffer => buildCaexEmpty(CAEX.LeaveShow);

/** CAEX EnterShow (5.1): ContentCode 0x00020100 + ucs2 Name. */
export function buildEnterShow(name: string): Buffer {
  const body = Buffer.concat([Buffer.alloc(4), Buffer.from(name + "\0", "utf16le")]);
  body.writeUInt32LE(CAEX.EnterShow, 0);
  return Buffer.concat([buildHeader(HEADER_SIZE + body.length, "CAEX"), body]);
}
/** CAEX LaserFeedList (6.2): 0x00030101, u32 SourceKey, u8 FeedCount, ucs2 Name[FeedCount]. */
export function buildLaserFeedList(sourceKey: number, names: string[] = []): Buffer {
  const parts = [Buffer.alloc(4), Buffer.alloc(4), Buffer.from([names.length])];
  parts[0].writeUInt32LE(CAEX.LaserFeedList, 0);
  parts[1].writeUInt32LE(sourceKey >>> 0, 0);
  for (const n of names) parts.push(Buffer.from(n + "\0", "utf16le"));
  const body = Buffer.concat(parts);
  return Buffer.concat([buildHeader(HEADER_SIZE + body.length, "CAEX"), body]);
}
/** CAEX NACK (2.2): 0xFFFFFFFF, u8 Reason (3 = refused). */
export function buildNack(reason: number): Buffer {
  const body = Buffer.alloc(5);
  body.writeUInt32LE(CAEX.NACK, 0);
  body[4] = reason;
  return Buffer.concat([buildHeader(HEADER_SIZE + body.length, "CAEX"), body]);
}

/** The ONLY CAEX codes that may ever be sent. */
export const ALLOWED_OUTGOING_CAEX: ReadonlySet<number> = new Set([CAEX.LaserFeedList, CAEX.EnterShow, CAEX.LeaveShow, CAEX.FixtureListRequest, CAEX.NACK]);

export function isAllowedOutgoing(msg: Buffer): boolean {
  if (msg.length < HEADER_SIZE + 4 || msg.toString("latin1", 0, 4) !== "CITP") return false;
  const layer = msg.toString("latin1", 16, 20);
  if (layer === "PINF") return msg.toString("latin1", 20, 24) === "PNam";
  if (layer === "CAEX") return ALLOWED_OUTGOING_CAEX.has(msg.readUInt32LE(20));
  return false;
}

export interface Identifier {
  type: number;
  name: string;
  size: number;
  hex: string;
  guid: string | null;
  guidRaw: string | null;
  value: string | null;
}
const ID_TYPES: Record<number, string> = {
  0x00: "RDMDeviceModelId",
  0x01: "RDMPersonalityId",
  0x02: "AtlaBaseFixtureId",
  0x03: "AtlaBaseModeId",
  0x04: "CaptureInstanceId",
  0x05: "RDMManufacturerId",
};

export interface CaexFixture {
  index: number;
  identifier: number;
  manufacturer: string;
  name: string;
  mode: string;
  channelCount: number;
  isDimmer: number;
  ids: Identifier[];
  /** As Capture sent them. Capture 2026 sends Patched=0, universe 0, address 0 for every fixture (verified on a real show): never used. */
  patched: number;
  universe: number;
  universeChannel: number;
  unit: string;
  /** Capture's own Channel number. */
  channel: number;
  circuit: string;
  note: string;
  position: [number, number, number];
  angles: [number, number, number];
}

/** Sequential reader; throws RangeError past the end of the message. */
class Cur {
  constructor(
    readonly b: Buffer,
    public p: number,
  ) {}
  need(n: number): void {
    if (this.p + n > this.b.length) throw new RangeError(`need ${n} byte(s) at offset ${this.p}, message ends at ${this.b.length}`);
  }
  u8(): number {
    this.need(1);
    return this.b[this.p++];
  }
  u16(): number {
    this.need(2);
    const v = this.b.readUInt16LE(this.p);
    this.p += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.b.readUInt32LE(this.p);
    this.p += 4;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.b.readFloatLE(this.p);
    this.p += 4;
    return v;
  }
  bytes(n: number): Buffer {
    this.need(n);
    const v = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return v;
  }
  ucs2(): string {
    const r = ucs2z(this.b, this.p);
    if (!r) throw new RangeError(`unterminated ucs2 string at offset ${this.p}`);
    this.p = r.next;
    return r.s;
  }
}

function decodeIdentifier(t: number, d: Buffer): Identifier {
  const o: Identifier = { type: t, name: ID_TYPES[t] || `unknown(0x${t.toString(16)})`, size: d.length, hex: hexOf(d), guid: null, guidRaw: null, value: null };
  if (d.length === 16) {
    o.guid = guidStr(d);
    o.guidRaw = guidRawStr(d);
  } else if (d.length === 2) o.value = String(d.readUInt16LE(0));
  else if (d.length === 8) o.value = d.readBigUInt64LE(0).toString();
  return o;
}

export interface FixtureListResult {
  type: number | null;
  count: number | null;
  fixtures: CaexFixture[];
  error: string | null;
}

/**
 * Decode a CAEX FixtureList (0x00020201, spec F 5.5): u8 Type, u16 FixtureCount, then per fixture
 * u32 FixtureIdentifier, ucs2 Manufacturer, FixtureName, ModeName, u16 ChannelCount, u8 IsDimmer, u8 IdentifierCount,
 * {u8 Type, u16 DataSize, data}[], u8 Patched, u8 Universe (0-based), u16 UniverseChannel (0-based), ucs2 Unit, u16 Channel,
 * ucs2 Circuit, ucs2 Note, float[3] Position, float[3] Angles.
 */
export function decodeFixtureList(msg: Buffer): FixtureListResult {
  const fixtures: CaexFixture[] = [];
  let count: number | null = null;
  let type: number | null = null;
  let error: string | null = null;
  try {
    const c = new Cur(msg, HEADER_SIZE + 4);
    type = c.u8();
    count = c.u16();
    for (let i = 0; i < count; i++) {
      const identifier = c.u32();
      const manufacturer = c.ucs2();
      const name = c.ucs2();
      const mode = c.ucs2();
      const channelCount = c.u16();
      const isDimmer = c.u8();
      const nid = c.u8();
      const ids: Identifier[] = [];
      for (let k = 0; k < nid; k++) {
        const t = c.u8();
        const sz = c.u16();
        ids.push(decodeIdentifier(t, c.bytes(sz)));
      }
      const patched = c.u8();
      const universe = c.u8();
      const universeChannel = c.u16();
      const unit = c.ucs2();
      const channel = c.u16();
      const circuit = c.ucs2();
      const note = c.ucs2();
      const position: [number, number, number] = [c.f32(), c.f32(), c.f32()];
      const angles: [number, number, number] = [c.f32(), c.f32(), c.f32()];
      fixtures.push({ index: i, identifier, manufacturer, name, mode, channelCount, isDimmer, ids, patched, universe, universeChannel, unit, channel, circuit, note, position, angles });
    }
  } catch (e) {
    error = (e as Error).message;
  }
  return { type, count, fixtures, error };
}

export interface DecodedMessage {
  layer: string | null;
  code: number | null;
  /** PLoc announcement (UDP) */
  ploc?: { port: number; type: string | null; name: string | null; state: string | null };
  showName?: string;
  fixtures?: FixtureListResult;
}

/** Decode what the sync needs from one complete CITP message: PLoc, EnterShow, requests, FixtureList. */
export function decodeMessage(msg: Buffer): DecodedMessage {
  const r: DecodedMessage = { layer: null, code: null };
  if (msg.length < HEADER_SIZE) return r;
  r.layer = fourcc(msg, 16);
  if (r.layer === "PINF") {
    if (fourcc(msg, 20) === "PLoc" && msg.length >= 26) {
      const port = msg.readUInt16LE(24);
      const type = ucs1z(msg, 26);
      const name = type && ucs1z(msg, type.next);
      const state = name && ucs1z(msg, name.next);
      r.ploc = { port, type: type && type.s, name: name && name.s, state: state && state.s };
    }
  } else if (r.layer === "CAEX" && msg.length >= HEADER_SIZE + 4) {
    r.code = msg.readUInt32LE(HEADER_SIZE);
    try {
      if (r.code === CAEX.FixtureList) r.fixtures = decodeFixtureList(msg);
      else if (r.code === CAEX.EnterShow) r.showName = new Cur(msg, HEADER_SIZE + 4).ucs2();
    } catch {
      /* undecodable body: the code alone is still returned */
    }
  }
  return r;
}

/** Splits a TCP byte stream into complete CITP messages; resynchronises on the next "CITP" cookie. */
export class CitpFramer {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private maxSize = 64 * 1024 * 1024) {}
  push(chunk: Buffer): { messages: Buffer[]; events: string[] } {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const messages: Buffer[] = [];
    const events: string[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      if (this.buf.toString("latin1", 0, 4) !== "CITP") {
        const next = this.buf.indexOf("CITP", 1, "latin1");
        const drop = next < 0 ? Math.max(0, this.buf.length - 3) : next;
        if (drop > 0) events.push(`framing: stream not at a CITP cookie; discarded ${drop} byte(s): ${hexOf(this.buf.subarray(0, drop), 64)}`);
        if (next < 0 && drop === 0) break;
        this.buf = this.buf.subarray(drop);
        if (next < 0) break;
        continue;
      }
      if (this.buf.length < HEADER_SIZE) break;
      const size = this.buf.readUInt32LE(8);
      if (size < HEADER_SIZE || size > this.maxSize) {
        events.push(`framing: implausible MessageSize ${size}; skipping 4 bytes to resync`);
        this.buf = this.buf.subarray(4);
        continue;
      }
      if (this.buf.length < size) break;
      messages.push(Buffer.from(this.buf.subarray(0, size)));
      this.buf = this.buf.subarray(size);
    }
    return { messages, events };
  }
}
