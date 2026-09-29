// Shared CITP helpers: message building, TCP stream framing, and decoding.
//
// SOURCES (the base CITP spec at bitbucket.org/lars_wernlund/citp / citp-protocol.org is blocked to automated
// fetching; see network-probe.mjs):
//  * CITP 1.0 base header, PINF/PNam and PINF/PLoc: jwarwick/citp-lib CITPDefines.h and puremediaserver
//    CITPDefines.h. PLoc decoding was confirmed against real Capture 2026 packets (handoff 03).
//  * CAEX layer (ContentType "CAEX"): "CITP CAEX Specification F" (Capture, 2020-07-03),
//    https://www.capture.se/Portals/0/Downloads/CITP%20CAEX%20Specification%20F.pdf. Layouts for NACK (2.2),
//    LaserFeedList (6.2), EnterShow/LeaveShow (5.1/5.2), FixtureList (5.5), FixtureSelection (5.9) and the
//    guid encoding come from handoff 04, which took them from the PDF directly. FixtureModify (5.7),
//    FixtureRemove (5.8), FixtureIdentify (5.6) and FixtureConsoleStatus (5.10) were NOT in that handoff:
//    they come from an automated summary of the PDF and are provisional (the raw hex is always logged).
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

/** CAEX EnterShow (5.1): ContentCode 0x00020100 + ucs2 Name. */
export function buildEnterShow(name, opts) {
  const body = Buffer.concat([Buffer.alloc(4), Buffer.from(name + '\0', 'utf16le')]);
  body.writeUInt32LE(CAEX.EnterShow, 0);
  return Buffer.concat([buildHeader(HEADER_SIZE + body.length, 'CAEX', opts), body]);
}
/** CAEX LeaveShow (5.2): ContentCode 0x00020101, no body. */
export const buildLeaveShow = (opts) => buildCaexEmpty(CAEX.LeaveShow, opts);
/** CAEX LaserFeedList (6.2): 0x00030101, u32 SourceKey, u8 FeedCount, ucs2 Name[FeedCount]. */
export function buildLaserFeedList(sourceKey, names = [], opts) {
  const parts = [Buffer.alloc(4), Buffer.alloc(4), Buffer.from([names.length])];
  parts[0].writeUInt32LE(CAEX.LaserFeedList, 0);
  parts[1].writeUInt32LE(sourceKey >>> 0, 0);
  for (const n of names) parts.push(Buffer.from(n + '\0', 'utf16le'));
  const body = Buffer.concat(parts);
  return Buffer.concat([buildHeader(HEADER_SIZE + body.length, 'CAEX', opts), body]);
}
export const NACK_REASONS = { 0: 'unknown', 1: 'malformed', 2: 'internal error', 3: 'refused' };
/** CAEX NACK (2.2): 0xFFFFFFFF, u8 Reason (0 unknown, 1 malformed, 2 internal error, 3 refused). */
export function buildNack(reason, opts) {
  const body = Buffer.alloc(5);
  body.writeUInt32LE(CAEX.NACK, 0); body[4] = reason;
  return Buffer.concat([buildHeader(HEADER_SIZE + body.length, 'CAEX', opts), body]);
}

/**
 * The ONLY messages the probe may ever put on the wire: PINF/PNam and these CAEX codes. Anything else
 * (FixtureList, FixtureModify, FixtureRemove, FixtureIdentify, FixtureSelection, FixtureConsoleStatus,
 * SetFixtureTransformationSpace, recorder/cue control, ...) is refused by isAllowedOutgoing().
 */
export const ALLOWED_OUTGOING_CAEX = new Set([
  CAEX.LaserFeedList, CAEX.EnterShow, CAEX.LeaveShow, CAEX.FixtureListRequest, CAEX.NACK,
]);
export function isAllowedOutgoing(msg) {
  if (msg.length < HEADER_SIZE + 4 || msg.toString('latin1', 0, 4) !== 'CITP') return false;
  const layer = msg.toString('latin1', 16, 20);
  if (layer === 'PINF') return msg.toString('latin1', 20, 24) === 'PNam';
  if (layer === 'CAEX') return ALLOWED_OUTGOING_CAEX.has(msg.readUInt32LE(20));
  return false;
}

const ID_TYPES = {
  0x00: 'RDMDeviceModelId', 0x01: 'RDMPersonalityId', 0x02: 'AtlaBaseFixtureId',
  0x03: 'AtlaBaseModeId', 0x04: 'CaptureInstanceId', 0x05: 'RDMManufacturerId',
};

/** Sequential reader; throws RangeError past the end of the message. */
class Cur {
  constructor(buf, pos) { this.b = buf; this.p = pos; }
  need(n) { if (this.p + n > this.b.length) throw new RangeError(`need ${n} byte(s) at offset ${this.p}, message ends at ${this.b.length}`); }
  u8() { this.need(1); return this.b[this.p++]; }
  u16() { this.need(2); const v = this.b.readUInt16LE(this.p); this.p += 2; return v; }
  u32() { this.need(4); const v = this.b.readUInt32LE(this.p); this.p += 4; return v; }
  f32() { this.need(4); const v = this.b.readFloatLE(this.p); this.p += 4; return v; }
  bytes(n) { this.need(n); const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  ucs2() { const r = ucs2z(this.b, this.p); if (!r) throw new RangeError(`unterminated ucs2 string at offset ${this.p}`); this.p = r.next; return r.s; }
  get left() { return this.b.length - this.p; }
}

/** Identifier -> {type, name, size, hex, guid, value} (value: u16 / u64 as decimal string; guid: COM mixed-endian string). */
function decodeIdentifier(t, d) {
  const o = { type: t, name: ID_TYPES[t] || `unknown(0x${t.toString(16)})`, size: d.length, hex: hexOf(d), guid: null, value: null };
  if (d.length === 16) o.guid = guidStr(d);
  else if (d.length === 2) o.value = String(d.readUInt16LE(0));
  else if (d.length === 8) o.value = d.readBigUInt64LE(0).toString();
  return o;
}

/**
 * Decode a CAEX FixtureList (0x00020201, spec F 5.5): u8 Type, u16 FixtureCount, then per fixture
 * u32 FixtureIdentifier, ucs2 Manufacturer, ucs2 FixtureName, ucs2 ModeName, u16 ChannelCount, u8 IsDimmer,
 * u8 IdentifierCount, {u8 Type, u16 DataSize, data}[], u8 Patched, u8 Universe (0-based),
 * u16 UniverseChannel (0-based), ucs2 Unit, u16 Channel, ucs2 Circuit, ucs2 Note, float[3] Position, float[3] Angles.
 * Returns {lines, type, count, fixtures, error}. `lines` lists the first `maxLog` fixtures in full.
 */
export function decodeFixtureList(msg, maxLog = 20, indent = '    ') {
  const lines = [], fixtures = [];
  let count = null, type = null, error = null;
  try {
    const c = new Cur(msg, HEADER_SIZE + 4);
    type = c.u8(); count = c.u16();
    lines.push(`${indent}FixtureList: Type=${type} (${['existing list', 'new', 'exchanged'][type] ?? 'unknown'}) FixtureCount=${count}`);
    for (let i = 0; i < count; i++) {
      const f = { index: i };
      f.identifier = c.u32();
      f.manufacturer = c.ucs2(); f.name = c.ucs2(); f.mode = c.ucs2();
      f.channelCount = c.u16(); f.isDimmer = c.u8();
      const nid = c.u8(); f.ids = [];
      for (let k = 0; k < nid; k++) { const t = c.u8(); const sz = c.u16(); f.ids.push(decodeIdentifier(t, c.bytes(sz))); }
      f.patched = c.u8(); f.universe = c.u8(); f.universeChannel = c.u16();
      f.unit = c.ucs2(); f.channel = c.u16(); f.circuit = c.ucs2(); f.note = c.ucs2();
      f.position = [c.f32(), c.f32(), c.f32()]; f.angles = [c.f32(), c.f32(), c.f32()];
      fixtures.push(f);
    }
    if (c.left) lines.push(`${indent}(${c.left} byte(s) left after the last fixture: ${hexOf(msg.subarray(c.p), 32)})`);
  } catch (e) {
    error = e.message;
    lines.push(`${indent}FixtureList decode stopped: ${e.message} (decoded ${fixtures.length} of ${count ?? '?'} fixture(s); raw hex is above)`);
  }
  fixtures.slice(0, maxLog).forEach((f) => {
    lines.push(`${indent}#${f.index} id=0x${f.identifier.toString(16).padStart(8, '0')} manufacturer=${JSON.stringify(f.manufacturer)} model=${JSON.stringify(f.name)} mode=${JSON.stringify(f.mode)} channels=${f.channelCount} dimmer=${f.isDimmer}` +
      ` patched=${f.patched} universe=${f.universe} (0-based) address=${f.universeChannel} (0-based)`);
    lines.push(`${indent}    unit=${JSON.stringify(f.unit)} channel=${f.channel} circuit=${JSON.stringify(f.circuit)} note=${JSON.stringify(f.note)}`);
    f.ids.forEach((d) => lines.push(`${indent}    id type=0x${d.type.toString(16).padStart(2, '0')} ${d.name} size=${d.size} ${d.guid ? 'guid=' + d.guid : d.value !== null ? 'value=' + d.value : ''} hex=${d.hex}`));
  });
  if (fixtures.length > maxLog && maxLog > 0) lines.push(`${indent}... ${fixtures.length - maxLog} more fixture(s) decoded but not listed`);
  return { lines, type, count, fixtures, error };
}

/** Fixed-width text table. */
export function textTable(headers, rows, indent = '  ') {
  const w = headers.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? '').length)));
  const fmt = (r) => indent + r.map((v, i) => String(v ?? '').padEnd(w[i])).join(' | ').trimEnd();
  return [fmt(headers), indent + w.map((n) => '-'.repeat(n)).join('-+-'), ...rows.map(fmt)];
}

const f3 = (a) => a.map((v) => (Number.isInteger(v) ? String(v) : v.toFixed(4))).join(', ');

/** Every fixture of a decoded FixtureList as plain-text tables (universe/address shown 1-based and raw 0-based). */
export function formatFixtureTables(fixtures) {
  const out = [];
  out.push(`Fixtures (${fixtures.length}). Universe/address: 1-based value, raw 0-based value in brackets.`);
  out.push(...textTable(
    ['#', 'identifier', 'manufacturer', 'model', 'mode', 'ch', 'dimmer', 'patched', 'universe', 'address', 'unit', 'channel', 'circuit', 'note'],
    fixtures.map((f) => [f.index, '0x' + f.identifier.toString(16).padStart(8, '0'), f.manufacturer, f.name, f.mode, f.channelCount, f.isDimmer ? 'yes' : 'no',
      f.patched ? 'yes' : 'no', `${f.universe + 1} [${f.universe}]`, `${f.universeChannel + 1} [${f.universeChannel}]`, f.unit, f.channel, f.circuit, f.note])));
  out.push('');
  out.push('Identifiers:');
  const idRows = [];
  for (const f of fixtures) for (const d of f.ids) idRows.push([f.index, `0x${d.type.toString(16).padStart(2, '0')}`, d.name, d.size, d.guid ?? d.value ?? d.hex]);
  out.push(...(idRows.length ? textTable(['#', 'type', 'name', 'size', 'value'], idRows) : ['  (none)']));
  out.push('');
  out.push('Position (x, y, z; right-handed, Z downstage, Y up) and angles (radians, Tait-Bryan X1 Y2 Z3):');
  out.push(...textTable(['#', 'position', 'angles'], fixtures.map((f) => [f.index, f3(f.position), f3(f.angles)])));
  return out;
}

const readIds = (c, n) => Array.from({ length: n }, () => c.u32());

/** Decode one complete CITP message (header + PINF/CAEX layers). Returns {layer, sub, code, lines, ...}. */
export function decodeMessage(msg, indent = '    ', { maxFixtures = 20 } = {}) {
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
    const c = new Cur(msg, HEADER_SIZE + 4);
    try {
      switch (r.code) {
        case CAEX.FixtureList: { const fl = decodeFixtureList(msg, maxFixtures, indent); lines.push(...fl.lines); r.fixtures = fl; break; }
        case CAEX.EnterShow: { r.showName = c.ucs2(); lines.push(`${indent}EnterShow: Name=${JSON.stringify(r.showName)}`); break; }
        case CAEX.LeaveShow: lines.push(`${indent}LeaveShow (no body)${c.left ? `; ${c.left} unexpected body byte(s): ${hexOf(msg.subarray(c.p), 32)}` : ''}`); break;
        case CAEX.GetLaserFeedList: lines.push(`${indent}GetLaserFeedList (request; no body)${c.left ? `; ${c.left} unexpected body byte(s)` : ''}`); r.request = true; break;
        case CAEX.LaserFeedList: {
          const key = c.u32(), n = c.u8(); const names = [];
          for (let i = 0; i < n; i++) names.push(c.ucs2());
          lines.push(`${indent}LaserFeedList: SourceKey=0x${key.toString(16).padStart(8, '0')} FeedCount=${n} Names=${JSON.stringify(names)}`); break;
        }
        case CAEX.NACK: {
          const reason = c.u8(); r.nackReason = reason;
          lines.push(`${indent}NACK: Reason=${reason} (${NACK_REASONS[reason] ?? 'undefined'})${c.left ? `; extra: ${hexOf(msg.subarray(c.p), 32)}` : ''}`); break;
        }
        case CAEX.FixtureSelection: {
          const n = c.u16(); r.selection = readIds(c, n);
          lines.push(`${indent}FixtureSelection: FixtureCount=${n} identifiers=[${r.selection.map((v) => '0x' + v.toString(16).padStart(8, '0')).join(', ')}]`); break;
        }
        case CAEX.FixtureRemove: {
          const n = c.u16(); const ids = readIds(c, n);
          lines.push(`${indent}FixtureRemove: FixtureCount=${n} identifiers=[${ids.map((v) => '0x' + v.toString(16).padStart(8, '0')).join(', ')}]`); break;
        }
        case CAEX.FixtureIdentify: {
          const n = c.u16(); const items = [];
          for (let i = 0; i < n; i++) items.push(`${guidStr(c.bytes(16))}/0x${c.u32().toString(16).padStart(8, '0')}`);
          lines.push(`${indent}FixtureIdentify (provisional layout): FixtureCount=${n} [${items.join(', ')}]`); break;
        }
        case CAEX.FixtureConsoleStatus: {
          const n = c.u16(); const items = [];
          for (let i = 0; i < n; i++) items.push(`0x${c.u32().toString(16).padStart(8, '0')}:locked=${c.u8()},clearable=${c.u8()}`);
          lines.push(`${indent}FixtureConsoleStatus (provisional layout): FixtureCount=${n} [${items.join(', ')}]`); break;
        }
        case CAEX.FixtureModify: {
          // PROVISIONAL (automated summary of spec F 5.7): per fixture u32 id, u8 ChangedFields, then fields present by bit:
          // 0x01 = u8 Patched + u8 Universe + u16 UniverseChannel; 0x02 = ucs2 Unit; 0x04 = u16 Channel; 0x08 = ucs2 Circuit;
          // 0x10 = ucs2 Note; 0x20 = float[3] Position + float[3] Angles.
          const n = c.u16(); const items = [];
          for (let i = 0; i < n; i++) {
            const id = c.u32(), ch = c.u8(); const parts = [`id=0x${id.toString(16).padStart(8, '0')}`, `changed=0x${ch.toString(16)}`];
            if (ch & 0x01) parts.push(`patched=${c.u8()}`, `universe=${c.u8()}(0-based)`, `address=${c.u16()}(0-based)`);
            if (ch & 0x02) parts.push(`unit=${JSON.stringify(c.ucs2())}`);
            if (ch & 0x04) parts.push(`channel=${c.u16()}`);
            if (ch & 0x08) parts.push(`circuit=${JSON.stringify(c.ucs2())}`);
            if (ch & 0x10) parts.push(`note=${JSON.stringify(c.ucs2())}`);
            if (ch & 0x20) parts.push(`position=[${f3([c.f32(), c.f32(), c.f32()])}]`, `angles=[${f3([c.f32(), c.f32(), c.f32()])}]`);
            items.push(parts.join(' '));
          }
          lines.push(`${indent}FixtureModify (provisional layout): FixtureCount=${n}`, ...items.map((x) => `${indent}  ${x}`));
          if (c.left) lines.push(`${indent}  (${c.left} byte(s) left over: ${hexOf(msg.subarray(c.p), 32)})`);
          break;
        }
        default: lines.push(`${indent}CAEX body not decoded (${msg.length - HEADER_SIZE - 4} byte(s)): ${hexOf(msg.subarray(HEADER_SIZE + 4), 32)}`);
      }
    } catch (e) { lines.push(`${indent}CAEX decode stopped: ${e.message} (raw hex is logged above)`); }
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
