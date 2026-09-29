// Shared CITP helpers: message building, TCP stream framing, and decoding.
//
// SOURCES (the base CITP spec at bitbucket.org/lars_wernlund/citp / citp-protocol.org is blocked to automated
// fetching; see network-probe.mjs):
//  * CITP 1.0 base header, PINF/PNam and PINF/PLoc: jwarwick/citp-lib CITPDefines.h and puremediaserver
//    CITPDefines.h. PLoc decoding was confirmed against real Capture 2026 packets (handoff 03).
//  * CAEX layer (ContentType "CAEX"): "CITP CAEX Specification F" (Capture, 2020-07-03),
//    https://www.capture.se/Portals/0/Downloads/CITP%20CAEX%20Specification%20F.pdf. The message table and
//    FixtureList layout below were extracted from that PDF through an automated summariser, NOT read by eye:
//    treat every CAEX decode as provisional and compare with the raw hex in the reports.
// All integers little-endian. ucs1 = null-terminated 8-bit string; ucs2 = null-terminated UTF-16LE.

export const HEADER_SIZE = 20;

export const hexOf = (buf, n = buf.length) =>
  [...buf.subarray(0, n)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
export const fourcc = (b, o) =>
  (b.length >= o + 4 ? b.toString('latin1', o, o + 4).replace(/[^\x20-\x7e]/g, '.') : null);

export function ucs1z(buf, pos) {
  let e = pos;
  while (e < buf.length && buf[e] !== 0) e++;
  if (e >= buf.length) return null;
  return { s: buf.toString('latin1', pos, e), next: e + 1 };
}
export function ucs2z(buf, pos) {
  let e = pos;
  while (e + 1 < buf.length && !(buf[e] === 0 && buf[e + 1] === 0)) e += 2;
  if (e + 1 >= buf.length) return null;
  return { s: buf.toString('utf16le', pos, e), next: e + 2 };
}

/** Mixed-endian GUID (Microsoft COM/OLE) as in CAEX spec F: 33 22 11 00 55 44 77 66 88 99 aa bb cc dd ee ff -> 00112233-4455-6677-8899-aabbccddeeff */
export function guidStr(b) {
  if (b.length !== 16) return null;
  const h = (i, n) => [...b.subarray(i, i + n)].map((x) => x.toString(16).padStart(2, '0')).join('');
  const r = (i, n) => [...b.subarray(i, i + n)].reverse().map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${r(0, 4)}-${r(4, 2)}-${r(6, 2)}-${h(8, 2)}-${h(10, 6)}`;
}

/** 20-byte CITP header. requestIndex goes in bytes 6-7 (Reserved in CITP 1.0). */
export function buildHeader(total, contentType, { major = 1, minor = 0, requestIndex = 0 } = {}) {
  const b = Buffer.alloc(HEADER_SIZE);
  b.write('CITP', 0, 'latin1');
  b[4] = major; b[5] = minor;
  b.writeUInt16LE(requestIndex, 6);
  b.writeUInt32LE(total, 8);
  b.writeUInt16LE(1, 12); // MessagePartCount
  b.writeUInt16LE(0, 14); // MessagePart
  b.write(contentType, 16, 'latin1');
  return b;
}

/** PINF/PNam: CITP header ('PINF') + 'PNam' + ucs1 Name. */
export function buildPNam(name, opts) {
  const nm = Buffer.concat([Buffer.from(name, 'latin1'), Buffer.from([0])]);
  const total = HEADER_SIZE + 4 + nm.length;
  return Buffer.concat([buildHeader(total, 'PINF', opts), Buffer.from('PNam', 'latin1'), nm]);
}

/** PINF/PLoc: as above with 'PLoc', u16 ListeningTCPPort, ucs1 Type, Name, State. */
export function buildPLoc(tcpPort, type, name, state, opts) {
  const z = (x) => Buffer.concat([Buffer.from(x, 'latin1'), Buffer.from([0])]);
  const port = Buffer.alloc(2); port.writeUInt16LE(tcpPort);
  const body = Buffer.concat([Buffer.from('PLoc', 'latin1'), port, z(type), z(name), z(state)]);
  return Buffer.concat([buildHeader(HEADER_SIZE + body.length, 'PINF', opts), body]);
}

export const CAEX = {
  NACK: 0xffffffff,
  GetLiveViewStatus: 0x00000100, LiveViewStatus: 0x00000101,
  GetLiveViewImage: 0x00000200, LiveViewImage: 0x00000201,
  SetCueRecordingCapabilities: 0x00010100, RecordCue: 0x00010200,
  SetRecorderClearingCapabilities: 0x00010300, ClearRecorder: 0x00010400,
  EnterShow: 0x00020100, LeaveShow: 0x00020101,
  SetFixtureTransformationSpace: 0x00020150,
  FixtureListRequest: 0x00020200, FixtureList: 0x00020201,
  FixtureModify: 0x00020202, FixtureRemove: 0x00020203, FixtureIdentify: 0x00020204,
  FixtureSelection: 0x00020300, FixtureConsoleStatus: 0x00020400,
  GetLaserFeedList: 0x00030100, LaserFeedList: 0x00030101, LaserFeedControl: 0x00030102, LaserFeedFrame: 0x00030200,
};
export const CAEX_NAMES = Object.fromEntries(Object.entries(CAEX).map(([k, v]) => [v, k]));

/** CAEX message with no body (only requests that are read-only should ever be built with this). */
export function buildCaexEmpty(code, opts) {
  const b = Buffer.alloc(HEADER_SIZE + 4);
  buildHeader(b.length, 'CAEX', opts).copy(b, 0);
  b.writeUInt32LE(code, HEADER_SIZE);
  return b;
}
/** The only CAEX request the probe is allowed to send. */
export const buildFixtureListRequest = (opts) => buildCaexEmpty(CAEX.FixtureListRequest, opts);

const ID_TYPES = { 0x00: 'RDMDeviceModelId', 0x01: 'RDMPersonalityId', 0x02: 'AtlaBaseFixtureId', 0x03: 'AtlaBaseModeId', 0x04: 'CaptureInstanceId', 0x05: 'RDMManufacturerId' };

/** Sequential reader used by the FixtureList decoder; throws RangeError past the end. */
class Cur {
  constructor(buf, pos) { this.b = buf; this.p = pos; }
  need(n) { if (this.p + n > this.b.length) throw new RangeError(`need ${n} byte(s) at offset ${this.p}, message ends at ${this.b.length}`); }
  u8() { this.need(1); return this.b[this.p++]; }
  u16() { this.need(2); const v = this.b.readUInt16LE(this.p); this.p += 2; return v; }
  u32() { this.need(4); const v = this.b.readUInt32LE(this.p); this.p += 4; return v; }
  f32() { this.need(4); const v = this.b.readFloatLE(this.p); this.p += 4; return v; }
  bytes(n) { this.need(n); const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  ucs2() { const r = ucs2z(this.b, this.p); if (!r) throw new RangeError(`unterminated ucs2 string at offset ${this.p}`); this.p = r.next; return r.s; }
}

/** Decode a CAEX FixtureList (0x00020201) message. Returns {lines, count, fixtures, error}. */
export function decodeFixtureList(msg, maxLog = 20, indent = '    ') {
  const lines = [];
  const fixtures = [];
  let count = null, error = null;
  try {
    const c = new Cur(msg, HEADER_SIZE + 4);
    const type = c.u8();
    count = c.u16();
    lines.push(`${indent}FixtureList: Type=${type} (${['existing patch', 'new', 'exchanged'][type] ?? 'unknown'}) FixtureCount=${count}`);
    for (let i = 0; i < count; i++) {
      const f = { index: i };
      f.identifier = c.u32();
      f.manufacturer = c.ucs2(); f.name = c.ucs2(); f.mode = c.ucs2();
      f.channelCount = c.u16(); f.isDimmer = c.u8();
      const nid = c.u8(); f.ids = [];
      for (let k = 0; k < nid; k++) {
        const t = c.u8(); const sz = c.u16(); const d = c.bytes(sz);
        f.ids.push({ type: t, name: ID_TYPES[t] || 'unknown', size: sz, hex: hexOf(d), guid: sz === 16 ? guidStr(d) : null,
          value: sz === 2 ? d.readUInt16LE(0) : sz === 8 ? d.readBigUInt64LE(0).toString() : null });
      }
      f.patched = c.u8(); f.universe = c.u8(); f.universeChannel = c.u16();
      f.unit = c.ucs2(); f.channel = c.u16(); f.circuit = c.ucs2(); f.note = c.ucs2();
      f.position = [c.f32(), c.f32(), c.f32()]; f.angles = [c.f32(), c.f32(), c.f32()];
      fixtures.push(f);
    }
    if (c.p !== msg.length) lines.push(`${indent}(${msg.length - c.p} byte(s) left after the last fixture: ${hexOf(msg.subarray(c.p), 32)})`);
  } catch (e) {
    error = e.message;
    lines.push(`${indent}FixtureList decode stopped: ${e.message} (decoded ${fixtures.length} of ${count ?? '?'} fixture(s); raw hex is above)`);
  }
  fixtures.slice(0, maxLog).forEach((f) => {
    lines.push(`${indent}#${f.index} manufacturer=${JSON.stringify(f.manufacturer)} model=${JSON.stringify(f.name)} mode=${JSON.stringify(f.mode)} channels=${f.channelCount} dimmer=${f.isDimmer}` +
      ` patched=${f.patched} universe=${f.universe} (0-based) address=${f.universeChannel} (0-based) fixtureId=0x${f.identifier.toString(16).padStart(8, '0')}`);
    lines.push(`${indent}    unit=${JSON.stringify(f.unit)} channel=${f.channel} circuit=${JSON.stringify(f.circuit)} note=${JSON.stringify(f.note)}`);
    f.ids.forEach((d) => lines.push(`${indent}    id type=0x${d.type.toString(16).padStart(2, '0')} ${d.name} size=${d.size} ${d.guid ? 'guid=' + d.guid : d.value !== null ? 'value=' + d.value : ''} hex=${d.hex}`));
  });
  if (fixtures.length > maxLog) lines.push(`${indent}... ${fixtures.length - maxLog} more fixture(s) decoded but not listed`);
  return { lines, count, fixtures, error };
}

/** Decode one complete CITP message (header + PINF/CAEX layers). Returns {layer, sub, code, lines}. */
export function decodeMessage(msg, indent = '    ') {
  const lines = [];
  const r = { layer: null, sub: null, code: null, lines };
  if (msg.length < HEADER_SIZE) { lines.push(`${indent}CITP header truncated (${msg.length} bytes < ${HEADER_SIZE})`); return r; }
  const size = msg.readUInt32LE(8);
  lines.push(`${indent}CITP header: version ${msg[4]}.${msg[5]}, bytes6-7=${hexOf(msg.subarray(6, 8))} (Reserved in 1.0 / RequestIndex later), MessageSize=${size}` +
    `${size === msg.length ? '' : ` (!= ${msg.length} bytes present)`}, MessagePartCount=${msg.readUInt16LE(12)}, MessagePart=${msg.readUInt16LE(14)}`);
  if (msg.readUInt16LE(12) > 1) lines.push(`${indent}NOTE: multi-part message (part ${msg.readUInt16LE(14) + 1}/${msg.readUInt16LE(12)}); no reassembly is attempted, decode below is of this part only`);
  r.layer = fourcc(msg, 16);
  lines.push(`${indent}content type (layer): "${r.layer}"`);
  if (r.layer === 'PINF') {
    r.sub = fourcc(msg, 20);
    lines.push(`${indent}sub-content type: "${r.sub}"`);
    try {
      if (r.sub === 'PLoc' && msg.length >= 26) {
        const port = msg.readUInt16LE(24);
        const type = ucs1z(msg, 26), name = type && ucs1z(msg, type.next), state = name && ucs1z(msg, name.next);
        lines.push(`${indent}PLoc: ListeningTCPPort=${port} Type=${JSON.stringify(type && type.s)} Name=${JSON.stringify(name && name.s)} State=${JSON.stringify(state && state.s)}`);
        r.ploc = { port, type: type && type.s, name: name && name.s, state: state && state.s };
      } else if (r.sub === 'PNam') {
        const name = ucs1z(msg, 24);
        lines.push(`${indent}PNam: Name=${JSON.stringify(name && name.s)}`);
      }
    } catch (e) { lines.push(`${indent}PINF decode failed: ${e.message}`); }
  } else if (r.layer === 'CAEX' && msg.length >= HEADER_SIZE + 4) {
    r.code = msg.readUInt32LE(HEADER_SIZE);
    r.sub = `0x${r.code.toString(16).padStart(8, '0')}`;
    lines.push(`${indent}CAEX ContentCode ${r.sub} = ${CAEX_NAMES[r.code] || 'unknown'}`);
    if (r.code === CAEX.FixtureList) {
      const fl = decodeFixtureList(msg, 20, indent);
      lines.push(...fl.lines); r.fixtures = fl;
    } else if (r.code === CAEX.EnterShow) {
      const nm = ucs2z(msg, HEADER_SIZE + 4);
      lines.push(`${indent}EnterShow: Name=${JSON.stringify(nm && nm.s)}`);
    } else if (r.code === CAEX.NACK) {
      lines.push(`${indent}NACK body: ${hexOf(msg.subarray(HEADER_SIZE + 4), 64)}`);
    }
  } else {
    r.sub = fourcc(msg, 20);
    lines.push(`${indent}layer not decoded here; next 8 bytes (20-27): ${hexOf(msg.subarray(20, 28))}`);
  }
  return r;
}

/**
 * Splits a TCP byte stream into complete CITP messages. push(chunk) -> {messages, events}.
 * Handles several messages in one chunk and a message split across chunks. If the stream does not
 * start with "CITP" (or MessageSize is implausible) it resynchronises on the next "CITP" and reports it.
 */
export class CitpFramer {
  constructor({ maxSize = 64 * 1024 * 1024 } = {}) { this.buf = Buffer.alloc(0); this.maxSize = maxSize; }
  get pending() { return this.buf.length; }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const messages = [], events = [];
    for (;;) {
      if (this.buf.length < 4) break;
      if (this.buf.toString('latin1', 0, 4) !== 'CITP') {
        const next = this.buf.indexOf('CITP', 1, 'latin1');
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
